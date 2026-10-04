import assert from "node:assert/strict";
import { test } from "node:test";
import { setColorMode } from "../extensions/shared/color";
import {
	gradientCacheSize,
	renderMuelsyseGradient,
	renderMuelsyseShimmer,
	shimmerClock,
	splitGraphemes,
} from "../extensions/zentui/gradient";

test("animated frames never grow the gradient cache", () => {
	setColorMode("truecolor");
	renderMuelsyseGradient("stable-cache-probe");
	const size = gradientCacheSize();
	for (let frame = 1; frame < 400; frame++) renderMuelsyseGradient("stable-cache-probe", frame / 400);
	assert.equal(gradientCacheSize(), size);
	const cached = renderMuelsyseGradient("stable-cache-probe");
	assert.equal(renderMuelsyseGradient("stable-cache-probe"), cached);
});

test("gradient follows the color mode", () => {
	setColorMode("truecolor");
	assert.match(renderMuelsyseGradient("ab"), /\x1b\[38;2;/);
	setColorMode("256color");
	const indexed = renderMuelsyseGradient("ab");
	assert.match(indexed, /\x1b\[38;5;\d+m/);
	assert.doesNotMatch(indexed, /38;2;/);
	setColorMode("none");
	assert.equal(renderMuelsyseGradient("ab"), "ab");
	setColorMode("truecolor");
});

const TECHNOLOGIST = "\u{1F469}\u200D\u{1F4BB}";
const E_ACUTE = "e\u0301";

test("grapheme clusters are painted as one unit", () => {
	assert.deepEqual(splitGraphemes("abc"), ["a", "b", "c"]);
	assert.deepEqual(splitGraphemes(`${TECHNOLOGIST}${E_ACUTE}`), [TECHNOLOGIST, E_ACUTE]);
	setColorMode("truecolor");
	const rendered = renderMuelsyseGradient(`${TECHNOLOGIST}${E_ACUTE}x`);
	assert.ok(rendered.includes(TECHNOLOGIST), "ZWJ sequence must not be split by color codes");
	assert.ok(rendered.includes(E_ACUTE), "combining mark must stay attached");
});

const SHIMMER_PROBE = "muelsyse-macaron";
const PULSE_MS = 1800;
const PULSE_START = 1_700_000_000_000;

function frameColors(rendered: string): readonly (readonly [number, number, number])[] {
	return [...rendered.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(
		(match) => [Number(match[1]), Number(match[2]), Number(match[3])] as const,
	);
}

function maxFrameJump(render: (elapsedMs: number) => string): number {
	const step = 25;
	const frames = 4 * (PULSE_MS / step);
	let previous = frameColors(render(0));
	let max = 0;
	for (let frame = 1; frame <= frames; frame++) {
		const colors = frameColors(render(frame * step));
		for (let index = 0; index < Math.min(colors.length, previous.length); index++) {
			const a = colors[index]!;
			const b = previous[index]!;
			max = Math.max(max, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
		}
		previous = colors;
	}
	return max;
}

test("footer shimmer advances without a wrap seam", () => {
	setColorMode("truecolor");
	// 25 ms 一帧、跨 4 个脉冲周期；旧写法（包裹相位 × 1/4 位移）每个周期把整条
	// 渐变回跳一次，逐字符最大色差超过 100 —— 肉眼就是一次闪断。
	const smooth = maxFrameJump((elapsed) =>
		renderMuelsyseShimmer(SHIMMER_PROBE, shimmerClock(PULSE_START + elapsed) * 0.25),
	);
	assert.ok(smooth < 12, `shimmer must advance smoothly, max frame jump ${smooth.toFixed(2)}`);

	const snapped = maxFrameJump((elapsed) =>
		renderMuelsyseGradient(SHIMMER_PROBE, (((PULSE_START + elapsed) % PULSE_MS) / PULSE_MS) * 0.25),
	);
	assert.ok(snapped > 40, `wrapped ramp shifts must not drive the shimmer, max frame jump ${snapped.toFixed(2)}`);
});
