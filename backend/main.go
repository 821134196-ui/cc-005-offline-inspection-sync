package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"inspection/backend/internal/api"
	"inspection/backend/internal/auth"
	"inspection/backend/internal/db"
	"inspection/backend/internal/store"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	cfg := api.Config{
		DatabaseURL: env("DATABASE_URL", "postgres://inspection:inspection@localhost:5432/inspection?sslmode=disable"),
		JWTSecret:   env("JWT_SECRET", "dev-secret-change-me"),
		MinIO: store.Config{
			Endpoint:  env("MINIO_ENDPOINT", "localhost:9000"),
			AccessKey: env("MINIO_ACCESS_KEY", "minioadmin"),
			SecretKey: env("MINIO_SECRET_KEY", "minioadmin"),
			Bucket:    env("MINIO_BUCKET", "inspection"),
			UseSSL:    os.Getenv("MINIO_USE_SSL") == "true",
		},
		ChunkSize: int64(envInt("CHUNK_SIZE", 6<<20)),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := db.ConnectWithRetry(ctx, cfg.DatabaseURL, 30)
	if err != nil {
		log.Fatalf("database: %v", err)
	}
	defer pool.Close()

	if err := db.Migrate(pool); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	if err := db.Seed(ctx, pool); err != nil {
		log.Fatalf("seed: %v", err)
	}

	obj, err := store.NewWithRetry(ctx, cfg.MinIO, 30)
	if err != nil {
		log.Fatalf("object storage: %v", err)
	}

	jwtm := auth.NewManager(cfg.JWTSecret, 24*time.Hour)
	srv := api.NewServer(cfg, pool, obj, jwtm)

	httpSrv := &http.Server{
		Addr:              ":" + env("PORT", "8080"),
		Handler:           srv.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("inspection backend listening on :%s", env("PORT", "8080"))
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()
	<-ctx.Done()
	shCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shCtx)
}

func envInt(key string, def int64) int64 {
	n := int64(0)
	for _, c := range os.Getenv(key) {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int64(c-'0')
	}
	if os.Getenv(key) == "" {
		return def
	}
	return n
}
