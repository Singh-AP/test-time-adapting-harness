"""Best-effort isolation for solver-written Python code.

Usage: python -I -B guard.py <scratch_dir> <code_file> <cpu_seconds>

The code runs with resource limits and a PEP 578 audit hook that blocks network access, process
creation, ctypes, and file access outside the scratch directory and the Python installation.
This is defense in depth, not a security boundary: run inside a container for untrusted settings.
"""

import os
import resource
import sys

BLOCKED_PREFIXES = (
    "socket.", "subprocess.", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork",
    "os.forkpty", "os.kill", "os.killpg", "pty.", "ctypes.", "_winapi.", "webbrowser.",
    "urllib.Request", "http.client.", "ftplib.", "smtplib.", "poplib.", "imaplib.", "nntplib.",
    "telnetlib.", "os.startfile", "sys.remote_exec",
)
# ctypes itself is preloaded (sympy imports it); its dangerous operations raise ctypes.* events, blocked above.
BLOCKED_MODULES = {"cffi"}
READ_PATH_EVENTS = {"os.listdir", "os.scandir", "glob.glob", "os.chdir"}
WRITE_PATH_EVENTS = {
    "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.symlink", "os.link",
    "os.truncate", "os.utime", "shutil.rmtree", "shutil.copyfile", "shutil.move",
}
TWO_PATH_EVENTS = {"os.rename", "os.symlink", "os.link", "shutil.copyfile", "shutil.move"}
DEVICES = {"/dev/null", "/dev/urandom", "/dev/random", "/dev/zero"}
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def _limit(kind, value):
    try:
        resource.setrlimit(kind, (value, value))
    except (ValueError, OSError):
        pass


def _disable_raw_spawn():
    """_posixsubprocess.fork_exec creates processes without raising an audit event; replace it."""
    try:
        import _posixsubprocess
    except ImportError:
        return

    def blocked(*args, **kwargs):
        raise PermissionError("blocked by sandbox: _posixsubprocess.fork_exec")

    _posixsubprocess.fork_exec = blocked


def _install(scratch):
    roots = {sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix, *sys.path}
    read_roots = tuple(sorted({os.path.realpath(r) for r in roots if r} | {scratch}))
    write_roots = (scratch,)

    def inside(path, allowed):
        if isinstance(path, int) or path is None:
            return True
        try:
            real = os.path.realpath(os.fsdecode(path))
        except Exception:
            return False
        return real in DEVICES or any(real == r or real.startswith(r + os.sep) for r in allowed)

    def deny(event, detail=""):
        raise PermissionError(f"blocked by sandbox: {event} {detail}".strip())

    def hook(event, args):
        if event.startswith(BLOCKED_PREFIXES):
            deny(event)
        if event == "import":
            name = (args[0] or "").split(".")[0]
            if name in BLOCKED_MODULES:
                raise ImportError(f"blocked by sandbox: import {args[0]}")
            return
        if event == "open":
            path, mode, flags = (list(args) + [None, None, None])[:3]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and bool(flags & WRITE_FLAGS)
            )
            if not inside(path, write_roots if writing else read_roots):
                deny("open", repr(path))
            return
        if event in READ_PATH_EVENTS or event in WRITE_PATH_EVENTS:
            allowed = write_roots if event in WRITE_PATH_EVENTS else read_roots
            if args and not inside(args[0], allowed):
                deny(event, repr(args[0]))
            if event in TWO_PATH_EVENTS and len(args) > 1 and not inside(args[1], write_roots):
                deny(event, repr(args[1]))

    sys.addaudithook(hook)


def main():
    scratch = os.path.realpath(sys.argv[1])
    code_path = sys.argv[2]
    cpu_seconds = int(sys.argv[3])
    with open(code_path, encoding="utf-8") as handle:
        source = handle.read()
    _limit(resource.RLIMIT_CPU, cpu_seconds)
    _limit(resource.RLIMIT_FSIZE, 16 << 20)
    if sys.platform == "darwin":
        _limit(resource.RLIMIT_NPROC, 0)
    if sys.platform.startswith("linux"):
        _limit(resource.RLIMIT_AS, 2 << 30)
    os.chdir(scratch)
    code = compile(source, "solver.py", "exec")
    import ctypes  # noqa: F401  # preload before the hook; see BLOCKED_MODULES

    _disable_raw_spawn()

    _install(scratch)
    sys.argv = ["solver.py"]
    exec(code, {"__name__": "__main__", "__builtins__": __builtins__})


if __name__ == "__main__":
    main()
