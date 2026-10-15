"""Command building and environment scrubbing for local and SSH hosts."""
import subprocess
import unittest

from e2elib.launch import Host, Invocation, claude_args, clean_env, command, run_claude, shell

MAC = Host("H1", "Mac CLI", None, "~/.local/bin/claude", "/usr/bin/python3",
           ["mcp__a__", "mcp__b__"], {"sample_app": "~/src/sample-app"})
VM = Host("H3", "earsvm", "earsvm.local", "~/.local/bin/claude", "/usr/bin/python3",
          ["mcp__a__"], {"sample_app": "~/src/sample app"})


class Args(unittest.TestCase):
    def test_prompt_first_allowed_tools_last(self):
        a = claude_args(MAC, Invocation("hi there", "sample_app", allow=("memory_save",), session_id="u1"))
        self.assertEqual(a[:2], ["-p", "hi there"])
        self.assertEqual(a[a.index("--permission-mode") + 1], "default")
        self.assertEqual(a[a.index("--session-id") + 1], "u1")
        self.assertEqual(a[-3:], ["--allowedTools", "mcp__a__memory_save", "mcp__b__memory_save"])

    def test_no_connector_loads_no_mcp_servers(self):
        a = claude_args(MAC, Invocation("hi", "sample_app", no_connector=True, resume="u2"))
        self.assertIn("--strict-mcp-config", a)
        self.assertEqual(a[a.index("--mcp-config") + 1], '{"mcpServers":{}}')
        self.assertEqual(a[a.index("--resume") + 1], "u2")
        self.assertNotIn("--allowedTools", a)

    def test_clean_env_drops_parent_session_variables(self):
        env = clean_env({"PATH": "/bin", "ANTHROPIC_API_KEY": "k", "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "cli",
                         "CLAUDE_PID": "9", "HOME": "/h"}, {"CLAUDE_MEMORY_KIT_PROMPT_HINT": "off"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h", "CLAUDE_MEMORY_KIT_PROMPT_HINT": "off"})

    def test_local_command_expands_claude_path(self):
        argv = command(MAC, Invocation("hi", "sample_app"))
        self.assertTrue(argv[0].endswith("/.local/bin/claude") and not argv[0].startswith("~"))

    def test_ssh_command_quotes_and_keeps_home_expandable(self):
        argv = command(VM, Invocation("it's me", "sample_app", env={"X": "a b"}))
        self.assertEqual(argv[:5], ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
        remote = argv[-1]
        self.assertTrue(remote.startswith("cd \"$HOME\"/'src/sample app' && env -u ANTHROPIC_API_KEY"))
        self.assertIn("X='a b'", remote)
        self.assertIn("'it'\"'\"'s me'", remote)
        self.assertTrue(remote.endswith("</dev/null"))

    def test_ssh_multiline_prompt_survives_one_remote_shell(self):
        import shlex
        remote = command(VM, Invocation("save these:\n- a\n- b", "sample_app"))[-1]
        words = shlex.split(remote.split(" && ", 1)[1].replace('"$HOME"/', "/h/"))
        self.assertEqual(words[words.index("-p") + 1], "save these:\n- a\n- b")


class Running(unittest.TestCase):
    def test_timeout_keeps_partial_output(self):
        def exec_(argv, cwd, env, timeout):
            raise subprocess.TimeoutExpired(argv, timeout, output='{"type":"system","subtype":"init","session_id":"z"}\n')
        r = run_claude(MAC, Invocation("hi", "sample_app"), exec_)
        self.assertTrue(r.timed_out)
        self.assertEqual(r.transcript.session_id, "z")

    def test_local_run_uses_dir_and_scrubbed_env(self):
        seen = {}

        def exec_(argv, cwd, env, timeout):
            seen.update(cwd=cwd, env=env)
            return subprocess.CompletedProcess(argv, 0, "", "")
        run_claude(MAC, Invocation("hi", "sample_app", env={"K": "v"}), exec_)
        self.assertTrue(seen["cwd"].endswith("/src/sample-app"))
        self.assertEqual(seen["env"]["K"], "v")
        self.assertFalse(any(k.startswith("CLAUDE_CODE_") for k in seen["env"]))

    def test_shell_raises_on_failure(self):
        def exec_(argv, cwd, env, timeout):
            return subprocess.CompletedProcess(argv, 2, "", "boom")
        with self.assertRaisesRegex(RuntimeError, "exited 2: boom"):
            shell(VM, "false", exec_)


if __name__ == "__main__":
    unittest.main()
