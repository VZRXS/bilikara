from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time


OutputMatcher = Callable[[str, str], object | None]


class CapturedProcess:
    """Drain a subprocess without allowing pipe reads to block test deadlines."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self._output: queue.Queue[tuple[str, str | None]] = queue.Queue()
        self._captured: dict[str, list[str]] = {"stdout": [], "stderr": []}
        self._closed_streams: set[str] = set()
        self._threads: list[threading.Thread] = []
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            thread = threading.Thread(
                target=self._drain_stream,
                args=(name, stream),
                daemon=True,
                name=f"smoke-{name}-reader",
            )
            thread.start()
            self._threads.append(thread)

    @classmethod
    def start(
        cls,
        command: Sequence[str],
        *,
        cwd: str | os.PathLike[str] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> CapturedProcess:
        process = subprocess.Popen(
            list(command),
            cwd=Path(cwd) if cwd is not None else None,
            env=dict(env) if env is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        return cls(process)

    def _drain_stream(self, name: str, stream) -> None:
        if stream is None:
            self._output.put((name, None))
            return
        try:
            for line in iter(stream.readline, ""):
                self._output.put((name, line))
        finally:
            stream.close()
            self._output.put((name, None))

    def _record(self, name: str, line: str | None) -> None:
        if line is None:
            self._closed_streams.add(name)
            return
        self._captured[name].append(line)

    def wait_for_output(self, matcher: OutputMatcher, timeout: float) -> object | None:
        if timeout <= 0:
            raise ValueError("output timeout must be positive")
        deadline = time.monotonic() + timeout
        exit_drain_deadline: float | None = None
        while True:
            now = time.monotonic()
            if self.process.poll() is not None and exit_drain_deadline is None:
                exit_drain_deadline = min(deadline, now + 1.0)
            active_deadline = min(deadline, exit_drain_deadline or deadline)
            remaining = active_deadline - now
            if remaining <= 0:
                self.drain_available()
                return None
            if len(self._closed_streams) == 2 and self._output.empty():
                return None
            try:
                name, line = self._output.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
            self._record(name, line)
            if line is not None:
                matched = matcher(name, line)
                if matched is not None:
                    return matched

    def drain_available(self) -> None:
        while True:
            try:
                name, line = self._output.get_nowait()
            except queue.Empty:
                return
            self._record(name, line)

    def finish_draining(self, timeout: float = 1.0) -> None:
        deadline = time.monotonic() + max(0.0, timeout)
        while len(self._closed_streams) < 2 and time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                name, line = self._output.get(timeout=min(0.1, max(0.0, remaining)))
            except queue.Empty:
                continue
            self._record(name, line)
        self.drain_available()

    def wait_for_exit(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.finish_draining()
                return True
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        if self.process.poll() is not None:
            self.finish_draining()
            return True
        return False

    @staticmethod
    def _process_group_exists(process_group_id: int) -> bool:
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _wait_for_process_group_exit(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            self.process.poll()
            if not self._process_group_exists(self.process.pid):
                return True
            self.drain_available()
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        self.process.poll()
        return not self._process_group_exists(self.process.pid)

    def terminate_process_group(
        self,
        *,
        terminate_timeout: float = 5.0,
        kill_timeout: float = 5.0,
    ) -> bool:
        if os.name == "posix":
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            group_exited = self._wait_for_process_group_exit(terminate_timeout)
            if not group_exited:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                group_exited = self._wait_for_process_group_exit(kill_timeout)
            process_exited = self.wait_for_exit(kill_timeout)
        else:
            if self.process.poll() is None:
                self.process.terminate()
            process_exited = self.wait_for_exit(terminate_timeout)
            if not process_exited:
                self.process.kill()
                process_exited = self.wait_for_exit(kill_timeout)
            group_exited = process_exited
        self.finish_draining()
        return group_exited and process_exited

    def captured_text(self, name: str) -> str:
        return "".join(self._captured[name])
