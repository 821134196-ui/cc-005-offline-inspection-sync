package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"

	"inspection/backend/internal/auth"
	"inspection/backend/internal/db"
	"inspection/backend/internal/store"
)

type Config struct {
	DatabaseURL string
	JWTSecret   string
	MinIO       store.Config
	ChunkSize   int64
}

type Server struct {
	cfg   Config
	pool  *pgxpool.Pool
	store *store.Store
	jwt   *auth.Manager
}

func NewServer(cfg Config, pool *pgxpool.Pool, st *store.Store, jwtm *auth.Manager) *Server {
	return &Server{cfg: cfg, pool: pool, store: st, jwt: jwtm}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("GET /api/me", s.auth(s.me))
	mux.HandleFunc("GET /api/inspections", s.auth(s.listInspections))
	mux.HandleFunc("GET /api/inspections/{id}", s.auth(s.getInspection))
	mux.HandleFunc("POST /api/sync", s.auth(s.sync))
	mux.HandleFunc("POST /api/conflicts/{id}/resolve", s.auth(s.resolveConflict))

	mux.HandleFunc("POST /api/uploads", s.auth(s.createUpload))
	mux.HandleFunc("GET /api/uploads/{uploadID}", s.auth(s.uploadStatus))
	mux.HandleFunc("PUT /api/uploads/{uploadID}/parts/{partNum}", s.auth(s.putPart))
	mux.HandleFunc("POST /api/uploads/{uploadID}/complete", s.auth(s.completeUpload))
	mux.HandleFunc("GET /api/attachments/{id}/download", s.auth(s.downloadAttachment))
	mux.HandleFunc("GET /api/attachments/{id}/content", s.auth(s.attachmentContent))

	return recoverer(cors(mux))
}

type ctxUserKey struct{}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing token")
			return
		}
		claims, err := s.jwt.Parse(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUserKey{}, claims)
		next(w, r.WithContext(ctx))
	}
}

func userFromCtx(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(ctxUserKey{}).(*auth.Claims)
	return c
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	code := db.Ready(r.Context(), s.pool)
	resp := map[string]any{
		"db":    code == http.StatusOK,
		"minio": s.store.Ping(r.Context()),
	}
	if code != http.StatusOK || !resp["minio"].(bool) {
		writeJSON(w, http.StatusServiceUnavailable, resp)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Op-Id")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				writeErr(w, http.StatusInternalServerError, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// silence unused imports in split files
var _ = minio.CompletePart{}
