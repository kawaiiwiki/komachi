package http

import (
	"bytes"
	"encoding/json"
	"io/fs"
	nethttp "net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// Exercise the production embed pattern through the Go toolchain, even when
// this checkout only has dist/.gitkeep and no built frontend. Milkdown's Vite
// chunks include _baseMerge-*.js, which ordinary recursive embedding omits.
func TestFrontendEmbedIncludesUnderscoreChunks(t *testing.T) {
	source, err := os.ReadFile("router.go")
	if err != nil {
		t.Fatal(err)
	}
	match := regexp.MustCompile(`(?m)^//go:embed (.+)\nvar frontend embed\.FS`).FindSubmatch(source)
	if len(match) != 2 {
		t.Fatal("frontend embed directive not found")
	}

	dir := t.TempDir()
	files := map[string]string{
		"go.mod":                            "module embedregression\n\ngo 1.26.0\n",
		"main.go":                           "package main\nimport \"embed\"\n//go:embed " + string(match[1]) + "\nvar frontend embed.FS\nfunc main() {}\n",
		"dist/index.html":                   `<script type="module" src="/static/editor.js"></script>`,
		"dist/static/editor.js":             `import "./_baseMerge-fixture.js";`,
		"dist/static/_baseMerge-fixture.js": `import "./nested/_dependency.js";`,
		"dist/static/nested/_dependency.js": `export const value = 1;`,
	}
	for name, content := range files {
		target := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command("go", "list", "-json", ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOWORK=off")
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list: %v", err)
	}
	var info struct{ EmbedFiles []string }
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatal(err)
	}
	for name := range files {
		if strings.HasPrefix(name, "dist/") && !slices.Contains(info.EmbedFiles, name) {
			t.Errorf("frontend binary would omit %s; embedded files: %v", name, info.EmbedFiles)
		}
	}
}

// With a real UI build present, verify the actual embedded FS and static HTTP
// responses, not only Vite's development server (which serves files from disk).
func TestEmbeddedFrontendBuiltAssets(t *testing.T) {
	if _, err := os.Stat("dist/index.html"); os.IsNotExist(err) {
		t.Skip("build/copy frontend/dist first to check production assets")
	} else if err != nil {
		t.Fatal(err)
	}
	staticFS, err := fs.Sub(frontend, "dist/static")
	if err != nil {
		t.Fatal(err)
	}
	handler := nethttp.StripPrefix("/static/", nethttp.FileServer(nethttp.FS(staticFS)))
	count := 0
	err = filepath.WalkDir("dist/static", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		expected, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		url := "/" + strings.TrimPrefix(filepath.ToSlash(name), "dist/")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(nethttp.MethodGet, url, nil))
		if recorder.Code != nethttp.StatusOK || !bytes.Equal(recorder.Body.Bytes(), expected) {
			t.Errorf("embedded asset %s: status=%d, body matches=%t", url, recorder.Code, bytes.Equal(recorder.Body.Bytes(), expected))
		}
		if strings.HasSuffix(name, ".js") && !strings.Contains(recorder.Header().Get("Content-Type"), "javascript") {
			t.Errorf("module %s has invalid Content-Type %q", url, recorder.Header().Get("Content-Type"))
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("UI build has no static assets")
	}
	t.Logf("verified %d embedded static assets", count)
}
