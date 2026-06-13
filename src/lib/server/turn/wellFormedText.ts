export function toWellFormedText(value: string): string {
	let output = '';
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				output += value[index] + value[index + 1];
				index++;
			} else {
				output += '\ufffd';
			}
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			output += '\ufffd';
			continue;
		}
		output += value[index];
	}
	return output;
}

export function sliceWellFormedText(value: string, end: number): string {
	const safeEnd = Math.max(0, Math.min(value.length, Math.trunc(end)));
	return toWellFormedText(value.slice(0, safeEnd));
}
