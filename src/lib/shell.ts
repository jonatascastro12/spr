import { GwError } from "./errors";

export async function runCmd(
  cmd: string[],
  opts: { cwd?: string; allowFailure?: boolean } = {}
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0 && !opts.allowFailure) {
    throw new GwError(
      `Command failed (${code}): ${cmd.join(" ")}\n${stderr.trim() || stdout.trim()}`
    );
  }

  return stdout.trim();
}
