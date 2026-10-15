"""The gh api wrapper, against canned API answers."""
import json
import subprocess
import unittest

from e2elib.gh import Commit, GhError, GitHub, gh_api

R = "me/claude-memory-test"


class FakeApi:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, args):
        self.calls.append(args)
        key = args[0] if args[0] != "-X" else " ".join(args[:3])
        for prefix, answer in self.routes.items():
            if key.startswith(prefix):
                if isinstance(answer, Exception):
                    raise answer
                return answer if isinstance(answer, str) else json.dumps(answer)
        raise GhError(404, f"no route {key}")


def commit(sha, msg, files):
    return {"sha": sha, "commit": {"message": msg}, "files": [{"filename": f, "status": s} for f, s in files]}


SERVER = "save: x\n\nMemory-Source: claude-code on mac\nMemory-Scope: general\n"
ROUTES = {
    f"repos/{R}/commits?since=": [{"sha": "b2"}, {"sha": "a1"}],            # newest first, like GitHub
    f"repos/{R}/commits/a1": commit("a1", SERVER, [("memories/x.md", "added"), ("MEMORY.md", "modified")]),
    f"repos/{R}/commits/b2": commit("b2", "hand edit\n", [("memories/y.md", "added")]),
    f"repos/{R}/contents/memories/x.md?ref=a1": "---\nname: x\n---\nbody e2e-r1-01\n",
    f"repos/{R}/contents/memories/gone.md?ref=HEAD": GhError(404, "Not Found"),
    f"repos/{R}/contents/memories/x.md": {"sha": "blob1"},
    f"-X DELETE repos/{R}/contents/memories/x.md": "{}",
}


class Retry(unittest.TestCase):
    def run_with(self, results):
        calls, sleeps = [], []

        def run(argv, **kw):
            calls.append(argv)
            rc, err = results.pop(0)
            return subprocess.CompletedProcess(argv, rc, "ok" if rc == 0 else "", err)
        return calls, sleeps, lambda: gh_api(["x"], run=run, sleep=sleeps.append)

    def test_connection_errors_are_retried(self):
        calls, sleeps, go = self.run_with([(1, "error connecting to api.github.com"), (0, "")])
        self.assertEqual(go(), "ok")
        self.assertEqual((len(calls), sleeps), (2, [2]))

    def test_http_errors_are_not_retried(self):
        calls, _, go = self.run_with([(1, "gh: Not Found (HTTP 404)")])
        with self.assertRaises(GhError) as e:
            go()
        self.assertEqual((e.exception.status, len(calls)), (404, 1))

    def test_gives_up_after_three_attempts(self):
        calls, sleeps, go = self.run_with([(1, "error connecting")] * 3)
        with self.assertRaises(GhError):
            go()
        self.assertEqual((len(calls), sleeps), (3, [2, 4]))


class Api(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi(ROUTES)
        self.gh = GitHub(self.api)

    def test_commits_oldest_first_with_files(self):
        cs = self.gh.commits_since(R, "2026-10-15T12:00:00Z")
        self.assertEqual([c.sha for c in cs], ["a1", "b2"])
        self.assertIn("since=2026-10-15T12%3A00%3A00Z", self.api.calls[0][0])
        self.assertEqual(cs[0].files, [("memories/x.md", "added"), ("MEMORY.md", "modified")])

    def test_empty_repo_has_no_commits(self):
        gh = GitHub(FakeApi({"repos/client/claude-memory/commits?since=": GhError(409, "Git Repository is empty.")}))
        self.assertEqual(gh.commits_since("client/claude-memory", "2026-10-15T12:00:00Z"), [])

    def test_commit_details_and_files_at_a_commit_are_fetched_once(self):
        for _ in range(3):
            self.gh.find([R], "2026-10-15T12:00:00Z", "e2e-r1-01")
        details = [c for c in self.api.calls if c[0].startswith(f"repos/{R}/commits/")]
        texts = [c for c in self.api.calls if c[0].startswith(f"repos/{R}/contents/memories/x.md?ref=a1")]
        self.assertEqual((len(details), len(texts)), (2, 1))

    def test_trailers(self):
        c = Commit("a", SERVER, [])
        self.assertEqual(c.trailers, {"Memory-Source": "claude-code on mac", "Memory-Scope": "general"})

    def test_find_only_server_commits_and_memory_paths(self):
        found = self.gh.find([R], "2026-10-15T12:00:00Z", "e2e-r1-01")
        self.assertEqual([(f.path, f.scope, f.sha) for f in found], [("memories/x.md", "general", "a1")])
        self.assertEqual(found[0].parts, {"project": None, "name": "x", "conflict": None})

    def test_missing_file_is_none_other_errors_raise(self):
        self.assertIsNone(self.gh.file_text(R, "memories/gone.md"))
        gh = GitHub(FakeApi({f"repos/{R}/contents/": GhError(500, "boom")}))
        with self.assertRaises(GhError):
            gh.file_text(R, "memories/x.md")

    def test_delete_uses_blob_sha_and_is_false_when_gone(self):
        self.assertTrue(self.gh.delete(R, "memories/x.md", "e2e cleanup r1"))
        self.assertEqual(self.api.calls[-1], ["-X", "DELETE", f"repos/{R}/contents/memories/x.md",
                                              "-f", "message=e2e cleanup r1", "-f", "sha=blob1"])
        self.assertFalse(self.gh.delete(R, "memories/none.md", "m"))

    def test_conflict_and_project_paths_parse(self):
        from e2elib.gh import Found
        f = Found(R, "projects/sample-app/memories/a-b.conflict-20261015T120000Z-2.md", "s", "x", "y")
        self.assertEqual(f.parts["project"], "sample-app")
        self.assertEqual(f.parts["conflict"], ".conflict-20261015T120000Z-2")


if __name__ == "__main__":
    unittest.main()
