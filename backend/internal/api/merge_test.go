package api

import (
	"encoding/json"
	"testing"
)

func TestClassifyField(t *testing.T) {
	cases := []struct {
		name            string
		server, v, base string
		want            fieldVerdict
	}{
		{"fast forward", `"a"`, `"b"`, `"a"`, verdictApply},
		{"no change", `"a"`, `"a"`, `"a"`, verdictNoop},
		{"converges after peer edit", `"b"`, `"b"`, `"a"`, verdictNoop},
		{"same field concurrent edit", `"b"`, `"c"`, `"a"`, verdictConflict},
		{"array fast forward", `[1,2]`, `[1,2,3]`, `[1,2]`, verdictApply},
		{"array conflict", `[1,2]`, `[9]`, `[1,2,3]`, verdictConflict},
		{"numeric equality regardless spacing", `10`, `10`, ` 10 `, verdictNoop},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyField(json.RawMessage(tc.server), json.RawMessage(tc.v), json.RawMessage(tc.base))
			if got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestEqualJSON(t *testing.T) {
	if !equalJSON(json.RawMessage(`{"a":1,"b":[2,3]}`), json.RawMessage(`{"b":[2,3],"a":1}`)) {
		t.Fatal("object key order must not matter")
	}
	if equalJSON(json.RawMessage(`{"a":1}`), json.RawMessage(`{"a":2}`)) {
		t.Fatal("different values compared equal")
	}
	if !equalJSON(json.RawMessage(`null`), json.RawMessage(`null`)) {
		t.Fatal("nulls should be equal")
	}
}

func TestValidateChanges(t *testing.T) {
	if err := validateChanges(nil, false); err == nil {
		t.Fatal("empty changes must be rejected")
	}
	if err := validateChanges(map[string]FieldChange{
		"owner_id": {V: json.RawMessage(`"x"`)},
	}, false); err == nil {
		t.Fatal("owner_id must never be client-writable")
	}
	if err := validateChanges(map[string]FieldChange{
		"status": {V: json.RawMessage(`"bogus"`), Base: json.RawMessage(`"draft"`)},
	}, false); err == nil {
		t.Fatal("invalid status must be rejected")
	}
	if err := validateChanges(map[string]FieldChange{
		"title": {V: json.RawMessage(`"ok"`)},
	}, true); err != nil {
		t.Fatalf("create without base should be allowed: %v", err)
	}
}
