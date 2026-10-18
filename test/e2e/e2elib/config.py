"""The e2e configuration (test/e2e/e2e.json) and the fixed prompt set (test/e2e/prompts.json)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from .launch import Host

HERE = Path(__file__).resolve().parent.parent


@dataclass
class Config:
    general_repo: str        # repo of scope `general`
    client_repo: str         # repo of the test client scope
    client_scope: str        # the client scope's name
    sample_project: str      # owner/repo of the test code repo (projects live in client_repo)
    kit_project: str         # owner/repo of claude-memory-cloud (its project lives in general_repo)
    repeats: int             # runs per routing prompt per host (spec: 3)
    hosts: Dict[str, Host]
    prompts: Dict[str, List[str]]
    second_client_scope: Optional[str] = None   # a second configured client scope; S20 is skipped without it

    @property
    def repos(self) -> List[str]:
        return [self.general_repo, self.client_repo]


def load(config_path: Path = HERE / "e2e.json", prompts_path: Path = HERE / "prompts.json") -> Config:
    d = json.loads(Path(config_path).read_text(encoding="utf-8"))
    hosts = {hid: Host(id=hid, label=h["label"], ssh=h.get("ssh"), claude=h["claude"], python=h["python"],
                       mcp_prefixes=list(h["mcp_prefixes"]), dirs=dict(h["dirs"]),
                       deny_prefixes=list(d.get("deny_mcp_prefixes", [])))
             for hid, h in d["hosts"].items()}
    prompts = json.loads(Path(prompts_path).read_text(encoding="utf-8"))
    return Config(general_repo=d["general_repo"], client_repo=d["client_repo"], client_scope=d["client_scope"],
                  sample_project=d["sample_project"], kit_project=d["kit_project"], repeats=int(d["repeats"]),
                  hosts=hosts, prompts={k: v for k, v in prompts.items() if not k.startswith("_")},
                  second_client_scope=d.get("second_client_scope"))
