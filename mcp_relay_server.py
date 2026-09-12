"""Minimal stdio MCP relay for Claude Desktop <-> Codex.
Messages are stored locally as JSONL; no network listener is opened.
"""
import json, sys, uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "relay"
INBOX, OUTBOX = ROOT / "to-codex.jsonl", ROOT / "to-claude.jsonl"
ROOT.mkdir(exist_ok=True)

def reply(i, result=None, error=None):
    x = {"jsonrpc":"2.0", "id":i}
    x["error"] = error if error else None
    if error is None: x["result"] = result
    else: x.pop("error", None); x["error"] = error
    print(json.dumps(x, ensure_ascii=False), flush=True)

def text_result(s):
    return {"content":[{"type":"text","text":s}]}

def append(path, message):
    item = {"id":str(uuid.uuid4()), "time":datetime.now(timezone.utc).isoformat(), "message":message}
    with path.open("a", encoding="utf-8") as f: f.write(json.dumps(item, ensure_ascii=False)+"\n")
    return item

def read_items(path, limit=20):
    if not path.exists(): return []
    rows=[]
    for line in path.read_text(encoding="utf-8").splitlines()[-limit:]:
        try: rows.append(json.loads(line))
        except json.JSONDecodeError: pass
    return rows

for line in sys.stdin:
    try:
        req=json.loads(line); method=req.get("method"); i=req.get("id")
        if method == "initialize":
            reply(i,{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"codex-relay","version":"1.0.0"}})
        elif method == "notifications/initialized": pass
        elif method == "tools/list":
            reply(i,{"tools":[
                {"name":"send_to_codex","description":"Send a message to Codex via the local relay.","inputSchema":{"type":"object","properties":{"message":{"type":"string"}},"required":["message"]}},
                {"name":"read_codex_replies","description":"Read recent replies from Codex.","inputSchema":{"type":"object","properties":{"limit":{"type":"integer","default":20}}}},
            ]})
        elif method == "tools/call":
            name=req.get("params",{}).get("name"); a=req.get("params",{}).get("arguments",{})
            if name=="send_to_codex": result=text_result(json.dumps(append(INBOX,a["message"]),ensure_ascii=False))
            elif name=="read_codex_replies": result=text_result(json.dumps(read_items(OUTBOX,int(a.get("limit",20))),ensure_ascii=False))
            else: reply(i,error={"code":-32601,"message":"Unknown tool"}); continue
            reply(i,result)
        elif i is not None: reply(i,error={"code":-32601,"message":"Unknown method"})
    except Exception as e:
        if 'i' in locals() and i is not None: reply(i,error={"code":-32603,"message":str(e)})
