import { execFile } from "node:child_process";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type GitRunner = (
	cwd: string,
	args: string[],
	options?: { env?: Record<string, string>; timeoutMs?: number },
) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Run git without a shell, never prompting for credentials. */
export const runGit: GitRunner = (cwd, args, options = {}) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{
				cwd,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
				env: {
					...process.env,
					GIT_TERMINAL_PROMPT: "0",
					GIT_EDITOR: "true",
					GIT_SEQUENCE_EDITOR: "true",
					...options.env,
				},
			},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code as number)
						: error
							? 1
							: 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});

/** Run an arbitrary configured command through the user's shell (index regeneration). */
export const runShell = (
	cwd: string,
	command: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<GitResult> =>
	new Promise((resolve) => {
		execFile(
			process.env.SHELL || "/bin/sh",
			["-c", command],
			{ cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? ((error as { code: number }).code as number)
						: error
							? 1
							: 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
