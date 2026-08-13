#!/usr/bin/env python3
"""Apply concurrent, read-only Remote SSE connection pressure to a running Host."""

from __future__ import annotations

import argparse
import http.client
import json
import socket
import statistics
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import ParseResult, urlencode, urlparse


@dataclass
class ClientStats:
    index: int
    connection_attempts: int = 0
    successful_connections: int = 0
    connected: bool = False
    events: int = 0
    state_events: int = 0
    disconnects: int = 0
    errors: int = 0
    reconnects: int = 0
    revisions: list[int] = field(default_factory=list)
    last_error: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


class RemoteSseClient(threading.Thread):
    def __init__(
        self,
        *,
        stats: ClientStats,
        parsed_url: ParseResult,
        stop_event: threading.Event,
        connect_timeout: float,
        reconnect_delay: float,
    ) -> None:
        super().__init__(name=f"remote-sse-load-{stats.index}", daemon=True)
        self.stats = stats
        self.parsed_url = parsed_url
        self.stop_event = stop_event
        self.connect_timeout = connect_timeout
        self.reconnect_delay = reconnect_delay
        self._connection_lock = threading.Lock()
        self._connection: http.client.HTTPConnection | None = None
        self._response: http.client.HTTPResponse | None = None

    def stop(self) -> None:
        with self._connection_lock:
            connection = self._connection
            response = self._response
        if connection is not None:
            response_socket = getattr(
                getattr(getattr(response, "fp", None), "raw", None),
                "_sock",
                None,
            )
            active_socket = connection.sock or response_socket
            if active_socket is not None:
                try:
                    active_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()

    def run(self) -> None:
        attempt = 0
        while not self.stop_event.is_set():
            if attempt:
                if self.stop_event.wait(self.reconnect_delay):
                    return
                with self.stats.lock:
                    self.stats.reconnects += 1
            attempt += 1
            with self.stats.lock:
                self.stats.connection_attempts += 1

            connection = self._new_connection()
            with self._connection_lock:
                self._connection = connection
            try:
                connection.request(
                    "GET",
                    self._event_path(),
                    headers={
                        "Accept": "text/event-stream",
                        "Cache-Control": "no-cache",
                        "User-Agent": "bilikara-remote-sse-load-test/1",
                    },
                )
                response = connection.getresponse()
                with self._connection_lock:
                    self._response = response
                if response.status != 200:
                    response.read(1024)
                    raise RuntimeError(f"HTTP {response.status} {response.reason}")
                content_type = response.getheader("Content-Type", "")
                if "text/event-stream" not in content_type.lower():
                    raise RuntimeError(f"unexpected Content-Type: {content_type or '<missing>'}")
                with self.stats.lock:
                    self.stats.connected = True
                    self.stats.successful_connections += 1
                disconnected = self._read_events(response)
                if disconnected and not self.stop_event.is_set():
                    with self.stats.lock:
                        self.stats.disconnects += 1
            except (OSError, http.client.HTTPException, RuntimeError) as exc:
                if not self.stop_event.is_set():
                    with self.stats.lock:
                        self.stats.errors += 1
                        self.stats.last_error = f"{type(exc).__name__}: {exc}"
            finally:
                connection.close()
                with self._connection_lock:
                    if self._connection is connection:
                        self._connection = None
                        self._response = None

    def _new_connection(self) -> http.client.HTTPConnection:
        connection_type = (
            http.client.HTTPSConnection
            if self.parsed_url.scheme == "https"
            else http.client.HTTPConnection
        )
        return connection_type(
            self.parsed_url.hostname,
            self.parsed_url.port,
            timeout=self.connect_timeout,
        )

    def _event_path(self) -> str:
        base_path = self.parsed_url.path.rstrip("/")
        path = f"{base_path}/api/events" if base_path else "/api/events"
        query = urlencode({"client_id": f"load-test-{self.stats.index}"})
        return f"{path}?{query}"

    def _read_events(self, response: http.client.HTTPResponse) -> bool:
        event_name = "message"
        data_lines: list[str] = []
        while not self.stop_event.is_set():
            raw_line = response.fp.readline()
            if not raw_line:
                return True
            line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
            if not line:
                if data_lines:
                    self._record_event(event_name, "\n".join(data_lines))
                event_name = "message"
                data_lines = []
                continue
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_name = line.removeprefix("event:").strip() or "message"
            elif line.startswith("data:"):
                data_lines.append(line.removeprefix("data:").lstrip())
        return False

    def _record_event(self, event_name: str, data: str) -> None:
        revision: int | None = None
        if event_name == "state":
            try:
                payload = json.loads(data)
                value = int(payload.get("state_revision") or 0)
                revision = value if value >= 0 else None
            except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
                revision = None
        with self.stats.lock:
            self.stats.events += 1
            if event_name == "state":
                self.stats.state_events += 1
            if revision is not None:
                self.stats.revisions.append(revision)


def _host_url(host: str, port: int) -> str:
    normalized_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{normalized_host}:{port}"


def _parse_base_url(parser: argparse.ArgumentParser, args: argparse.Namespace) -> ParseResult:
    if args.base_url and (args.host or args.port is not None):
        parser.error("use either BASE_URL or --host/--port, not both")
    if args.base_url:
        base_url = args.base_url
    else:
        base_url = _host_url(args.host or "127.0.0.1", args.port or 8080)
    if "://" not in base_url:
        base_url = f"http://{base_url}"
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        parser.error("BASE_URL must be an http(s) URL or host:port")
    if parsed.query or parsed.fragment:
        parser.error("BASE_URL must not contain a query string or fragment")
    try:
        _ = parsed.port
    except ValueError as exc:
        parser.error(str(exc))
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Open concurrent, read-only /api/events connections against a running Bilikara Host.",
    )
    parser.add_argument("base_url", nargs="?", help="Host base URL or host:port")
    parser.add_argument("--host", help="Host name or IP (alternative to BASE_URL)")
    parser.add_argument("--port", type=int, help="Host port (default: 8080)")
    parser.add_argument("--clients", type=int, default=20, help="concurrent clients (default: 20)")
    parser.add_argument("--duration", type=float, default=15.0, help="run time in seconds (default: 15)")
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=5.0,
        help="connection timeout in seconds (default: 5)",
    )
    parser.add_argument(
        "--reconnect-delay",
        type=float,
        default=1.0,
        help="delay before reconnect attempts in seconds (default: 1)",
    )
    return parser


def _validate_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.clients < 1:
        parser.error("--clients must be at least 1")
    if args.duration <= 0:
        parser.error("--duration must be greater than 0")
    if args.connect_timeout <= 0:
        parser.error("--connect-timeout must be greater than 0")
    if args.reconnect_delay < 0.25:
        parser.error("--reconnect-delay must be at least 0.25 seconds")
    if args.port is not None and not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    _validate_args(parser, args)
    parsed_url = _parse_base_url(parser, args)

    stop_event = threading.Event()
    stats = [ClientStats(index=index + 1) for index in range(args.clients)]
    clients = [
        RemoteSseClient(
            stats=client_stats,
            parsed_url=parsed_url,
            stop_event=stop_event,
            connect_timeout=args.connect_timeout,
            reconnect_delay=args.reconnect_delay,
        )
        for client_stats in stats
    ]

    started_at = time.monotonic()
    for client in clients:
        client.start()
    stop_event.wait(args.duration)
    stop_event.set()
    for client in clients:
        client.stop()
    for client in clients:
        client.join(timeout=args.connect_timeout + 1.0)
    runtime = time.monotonic() - started_at

    for client, client_stats in zip(clients, stats, strict=True):
        if client.is_alive():
            with client_stats.lock:
                client_stats.errors += 1
                client_stats.last_error = "worker did not stop after connection close"

    snapshots: list[dict[str, object]] = []
    for client_stats in stats:
        with client_stats.lock:
            snapshots.append(
                {
                    "index": client_stats.index,
                    "connected": client_stats.connected,
                    "successful_connections": client_stats.successful_connections,
                    "attempts": client_stats.connection_attempts,
                    "reconnects": client_stats.reconnects,
                    "events": client_stats.events,
                    "state_events": client_stats.state_events,
                    "disconnects": client_stats.disconnects,
                    "errors": client_stats.errors,
                    "revisions": list(client_stats.revisions),
                    "last_error": client_stats.last_error,
                }
            )

    for snapshot in snapshots:
        revisions = snapshot["revisions"]
        revision_summary = "-" if not revisions else f"{min(revisions)}..{max(revisions)}"
        error_suffix = f" last_error={snapshot['last_error']}" if snapshot["last_error"] else ""
        print(
            f"client {snapshot['index']:02d}: connected={snapshot['connected']} "
            f"successful_connections={snapshot['successful_connections']} "
            f"attempts={snapshot['attempts']} reconnects={snapshot['reconnects']} "
            f"events={snapshot['events']} state_events={snapshot['state_events']} "
            f"revisions={revision_summary} disconnects={snapshot['disconnects']} "
            f"errors={snapshot['errors']}{error_suffix}"
        )

    event_counts = [int(snapshot["events"]) for snapshot in snapshots]
    successful_clients = sum(bool(snapshot["connected"]) for snapshot in snapshots)
    total_events = sum(event_counts)
    total_state_events = sum(int(snapshot["state_events"]) for snapshot in snapshots)
    total_disconnects = sum(int(snapshot["disconnects"]) for snapshot in snapshots)
    total_errors = sum(int(snapshot["errors"]) for snapshot in snapshots)
    total_reconnects = sum(int(snapshot["reconnects"]) for snapshot in snapshots)

    print("aggregate:")
    print(f"  requested clients: {args.clients}")
    print(f"  successful clients: {successful_clients}")
    print(f"  total events: {total_events}")
    print(f"  total state events: {total_state_events}")
    print(f"  disconnects: {total_disconnects}")
    print(f"  errors: {total_errors}")
    print(f"  reconnects: {total_reconnects}")
    print(f"  runtime seconds: {runtime:.2f}")
    print(
        "  events/client: "
        f"min={min(event_counts)} median={statistics.median(event_counts):.1f} "
        f"mean={statistics.fmean(event_counts):.1f} max={max(event_counts)}"
    )
    return 0 if successful_clients == args.clients and total_errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
