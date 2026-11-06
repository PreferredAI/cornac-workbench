"""Serve the local diagnostic API and optional built web assets, without frameworks."""

import argparse
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from workbench import DEFAULT_BUNDLE, POLICIES, compare, export_session, group_members, load_bundle, query_by_id, query_summaries, replay_session


def handler_for(bundle, static_root):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(static_root), **kwargs)

        def send_json(self, value, status=200, download=None):
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            if download:
                self.send_header("Content-Disposition", f'attachment; filename="{download}"')
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self):
            parsed = urlparse(self.path)
            args = {key: values[-1] for key, values in parse_qs(parsed.query).items()}
            try:
                if parsed.path == "/api/bootstrap":
                    models = {name: {key: value for key, value in model.items() if key != "groups"}
                              for name, model in bundle["models"].items()}
                    self.send_json({"schema_version": 1, "scope": bundle["scope"], "models": models,
                                    "baseline": bundle["baseline"], "resolver_contract": bundle["resolver_contract"],
                                    "policies": list(POLICIES), "cutoffs": [5, 10, 20],
                                    "provenance": bundle["provenance"]})
                elif parsed.path == "/api/queries":
                    self.send_json({"queries": query_summaries(bundle, args.get("model", "letter-openai-2025"),
                                                               int(args.get("cutoff", 10)), args.get("category", "all"))})
                elif parsed.path in ("/api/query", "/api/export"):
                    query_index = int(args["query"])
                    model = args.get("model", "letter-openai-2025")
                    cutoff = int(args.get("cutoff", 10))
                    if parsed.path == "/api/export":
                        self.send_json(export_session(bundle, query_index, model, cutoff),
                                       download=f"cornac-query-{query_index}-{model}-k{cutoff}.json")
                    else:
                        result = compare(bundle, query_index, model, cutoff)
                        indices = set(result["history_item_indices"] + [result["target_item_index"]] + result["sasrec"]["ranked_item_indices"])
                        for policy in result["policies"].values():
                            indices.update(row["selected_item_index"] for row in policy["slots"] if row["selected_item_index"] is not None)
                        result["items"] = {str(index): bundle["items"][str(index)] for index in indices}
                        query_obj = query_by_id(bundle, query_index)
                        target_addr = query_obj["runs"][model]["target_address"]
                        target_group = group_members(bundle, query_index, model, target_addr, "popularity", 0, 1)
                        result["target_context"] = {
                            "target_address": target_addr,
                            "target_group_size": target_group["total"],
                            "target_popularity_rank": target_group["target_popularity_rank"],
                            "target_cosine_rank": target_group["target_cosine_rank"],
                            "target_popularity_score": bundle["items"][str(result["target_item_index"])]["training_count"],
                            "target_cosine_score": query_obj["history_cosine_scores"][result["target_item_index"]],
                        }
                        self.send_json(result)
                elif parsed.path == "/api/group":
                    self.send_json(group_members(bundle, int(args["query"]), args.get("model", "letter-openai-2025"),
                                                  [int(value) for value in args["address"].split(",")],
                                                  args.get("resolver", "popularity"), int(args.get("offset", 0)),
                                                  int(args.get("limit", 50)), args.get("search", "")))
                elif parsed.path.startswith("/api/"):
                    self.send_json({"error": "Unknown API endpoint"}, HTTPStatus.NOT_FOUND)
                elif not (static_root / "index.html").exists() and parsed.path == "/":
                    self.send_json({"status": "API ready", "frontend": "Build web assets or use the Vite development server", "bootstrap": "/api/bootstrap"})
                elif parsed.path == "/":
                    # Advertise the local diagnostic API only when it is actually served.
                    # The same built journey remains API-free on a plain static host.
                    html = (static_root / "index.html").read_text().replace("</head>", "<script>window.CORNAC_DIAGNOSTICS=true</script></head>").encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(html)))
                    self.end_headers()
                    self.wfile.write(html)
                else:
                    super().do_GET()
            except (KeyError, ValueError, StopIteration) as error:
                self.send_json({"error": str(error) or "Unknown query or item"}, HTTPStatus.BAD_REQUEST)

        def do_POST(self):
            if urlparse(self.path).path != "/api/replay":
                self.send_json({"error": "Unknown API endpoint"}, HTTPStatus.NOT_FOUND)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 16 * 1024 * 1024:
                    raise ValueError("Expected a session JSON file smaller than 16 MiB")
                session = json.loads(self.rfile.read(length))
                self.send_json({"status": "passed", "result": replay_session(session)})
            except (ValueError, KeyError, TypeError, StopIteration) as error:
                self.send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8080, type=int)
    parser.add_argument("--bundle", default=DEFAULT_BUNDLE, type=Path)
    parser.add_argument("--static", default=Path(__file__).parent / "web/dist", type=Path)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), handler_for(load_bundle(args.bundle), args.static.resolve()))
    print(f"Cornac workbench: http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
