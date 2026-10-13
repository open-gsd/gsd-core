# Run a command under a pseudo-terminal for a fixed time and write everything it printed to a file.
# usage: pty-capture.py <out-file> <seconds> <cwd> <cmd> [args...]   (environment is inherited)
import fcntl, os, pty, select, signal, struct, sys, termios, time

out, secs, cwd = sys.argv[1], float(sys.argv[2]), sys.argv[3]
cmd = sys.argv[4:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
buf = b''
end = time.time() + secs
# Optional typed input: PTY_INPUT (text, \r for Enter written as \\r) is sent once after PTY_DELAY seconds.
typed = os.environ.get('PTY_INPUT')
send_at = time.time() + float(os.environ.get('PTY_DELAY', '6'))
while time.time() < end:
    if typed is not None and time.time() >= send_at:
        os.write(fd, typed.replace('\\r', '\r').encode())
        typed = None
    ready, _, _ = select.select([fd], [], [], 0.3)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        buf += data
# The child leads its own session: kill the whole group so helpers it started die with it.
for target in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
    try:
        target()
        break
    except OSError:
        continue
try:
    os.waitpid(pid, 0)
except OSError:
    pass
time.sleep(1)
open(out, 'wb').write(buf)
