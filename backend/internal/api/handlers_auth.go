package api

import (
	"encoding/json"
	"net/http"

	"golang.org/x/crypto/bcrypt"
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	var (
		id, hash, display string
	)
	err := s.pool.QueryRow(r.Context(),
		`SELECT id, password_hash, display_name FROM users WHERE username=$1`, req.Username).
		Scan(&id, &hash, &display)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	token, err := s.jwt.Issue(id, req.Username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "token failure")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":        token,
		"user_id":      id,
		"username":     req.Username,
		"display_name": display,
	})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	c := userFromCtx(r.Context())
	var display string
	if err := s.pool.QueryRow(r.Context(),
		`SELECT display_name FROM users WHERE id=$1`, c.UserID).Scan(&display); err != nil {
		writeErr(w, http.StatusUnauthorized, "unknown user")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_id": c.UserID, "username": c.Username, "display_name": display,
	})
}
