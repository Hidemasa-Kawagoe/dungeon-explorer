type Child = Node | string | null | undefined | false;

/** Tiny DOM builder. Text is always set via text nodes (never innerHTML), so user data can't inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Record<string, unknown> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === undefined || v === false) continue;
		if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
		else if (k === "class") el.className = String(v);
		else if (k in el) (el as any)[k] = v;
		else el.setAttribute(k, String(v));
	}
	for (const c of children) if (c) el.append(c);
	return el;
}
