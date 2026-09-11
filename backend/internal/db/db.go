package db

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

//go:embed migrations/*.sql
var embeddedMigrations embed.FS

func ConnectWithRetry(ctx context.Context, url string, attempts int) (*pgxpool.Pool, error) {
	var last error
	for i := 0; i < attempts; i++ {
		pool, err := pgxpool.New(ctx, url)
		if err == nil {
			if pingErr := pool.Ping(ctx); pingErr == nil {
				return pool, nil
			} else {
				last = pingErr
				pool.Close()
			}
		} else {
			last = err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, fmt.Errorf("connect after %d attempts: %w", attempts, last)
}

// Migrate applies every embedded *.sql migration in name order, each wrapped in
// a transaction. Dependency-free auto migration running on every boot.
func Migrate(pool *pgxpool.Pool) error {
	return migrateEmbedded(pool)
}

func migrateEmbedded(pool *pgxpool.Pool) error {
	entries, err := embeddedMigrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	ctx := context.Background()
	for _, e := range entries {
		data, err := embeddedMigrations.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		if err := applySQL(ctx, pool, string(data)); err != nil {
			return fmt.Errorf("migration %s: %w", e.Name(), err)
		}
	}
	return nil
}

func applySQL(ctx context.Context, pool *pgxpool.Pool, sql string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, sql); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Seed creates demo users, sample inspections assigned to them and a demo
// attachment record. Idempotent: safe on every boot.
func Seed(ctx context.Context, pool *pgxpool.Pool) error {
	type user struct {
		id, username, password, display string
	}
	users := []user{
		{"11111111-1111-1111-1111-111111111111", "alice", "demo1234", "Alice Inspector"},
		{"22222222-2222-2222-2222-222222222222", "bob", "demo1234", "Bob Inspector"},
	}
	for _, u := range users {
		hash, err := bcrypt.GenerateFromPassword([]byte(u.password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		_, err = pool.Exec(ctx, `
			INSERT INTO users (id, username, password_hash, display_name)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (username) DO NOTHING`,
			u.id, u.username, string(hash), u.display)
		if err != nil {
			return err
		}
	}
	samples := []struct {
		id, owner, title, findings, notes string
		items                             []map[string]any
	}{
		{
			id: "a1111111-0000-0000-0000-000000000001", owner: users[0].id,
			title: "锅炉车间日常巡检", findings: "", notes: "离线演示：可直接修改，断网后刷新页面再同步",
			items: []map[string]any{
				{"id": "i1", "label": "压力表读数正常", "ok": true, "comment": ""},
				{"id": "i2", "label": "阀门无泄漏", "ok": true, "comment": ""},
				{"id": "i3", "label": "安全阀校验有效", "ok": false, "comment": "待确认标签日期"},
			},
		},
		{
			id: "a1111111-0000-0000-0000-000000000002", owner: users[0].id,
			title: "配电室周检", findings: "", notes: "",
			items: []map[string]any{
				{"id": "j1", "label": "开关柜温度", "ok": false, "comment": ""},
				{"id": "j2", "label": "接地电阻", "ok": true, "comment": ""},
			},
		},
		{
			id: "a2222222-0000-0000-0000-000000000001", owner: users[1].id,
			title: "仓库消防巡检（Bob）", findings: "", notes: "用于验证越权同步：alice 无法同步此任务",
			items: []map[string]any{
				{"id": "k1", "label": "灭火器压力", "ok": true, "comment": ""},
			},
		},
	}
	for _, s := range samples {
		itemsJSON, err := json.Marshal(s.items)
		if err != nil {
			return err
		}
		_, err = pool.Exec(ctx, `
			INSERT INTO inspections (id, owner_id, title, findings, notes, checked_items)
			VALUES ($1,$2,$3,$4,$5,$6::jsonb)
			ON CONFLICT (id) DO NOTHING`,
			s.id, s.owner, s.title, s.findings, s.notes, string(itemsJSON))
		if err != nil {
			return err
		}
		// establish field lineage for seeded rows
		for f, v := range map[string]any{
			"title": s.title, "findings": s.findings, "notes": s.notes,
			"checked_items": s.items, "photo_caption": "", "status": "draft",
		} {
			encoded, err := json.Marshal(v)
			if err != nil {
				return err
			}
			_, err = pool.Exec(ctx, `
				INSERT INTO field_revs (inspection_id, field, value, op_id)
				VALUES ($1,$2,$3::jsonb,'00000000-0000-0000-0000-000000000000')
				ON CONFLICT (inspection_id, field) DO NOTHING`,
				s.id, f, string(encoded))
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// Readiness probe verifies DB connectivity; MinIO is probed separately in the
// HTTP handler.
func Ready(ctx context.Context, pool *pgxpool.Pool) int {
	if err := pool.Ping(ctx); err != nil {
		return http.StatusServiceUnavailable
	}
	return http.StatusOK
}
