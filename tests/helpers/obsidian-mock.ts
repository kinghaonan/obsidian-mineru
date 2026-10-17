/**
 * 测试专用的 obsidian 运行时钩子。
 *
 * esbuild 打包测试时把 "obsidian" 指向 tests/stubs/obsidian.ts，
 * 而 tsc 仍使用真实的 obsidian 类型，因此这里通过断言取出 stub 独有的钩子。
 */
import * as obsidian from "obsidian";

export interface RecordedNotice {
	message: string;
	duration?: number;
}

export interface StubRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface StubResponse {
	status: number;
	text?: string;
	json?: unknown;
	arrayBuffer?: ArrayBuffer;
}

export type RequestHandler = (req: StubRequest) => StubResponse;

interface MockHooks {
	__setRequestHandler(handler: RequestHandler | null): void;
	__takeNotices(): RecordedNotice[];
}

const hooks = obsidian as unknown as MockHooks;

export function setRequestHandler(handler: RequestHandler | null): void {
	hooks.__setRequestHandler(handler);
}

/** 取出并清空 stub 记录的 Notice 消息 */
export function takeNotices(): string[] {
	return hooks.__takeNotices().map((n) => n.message);
}

/** 取回测试期间产生的所有 Notice（不清空） */
export function peekNotices(): RecordedNotice[] {
	return (obsidian as unknown as MockHooks & { __peekNotices(): RecordedNotice[] }).__peekNotices();
}