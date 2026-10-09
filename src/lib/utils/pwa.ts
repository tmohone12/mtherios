export function isStandalone(displayMode: boolean, navigatorStandalone = false): boolean {
	return displayMode || navigatorStandalone;
}

export function isIosSafari(userAgent: string, platform = '', maxTouchPoints = 0): boolean {
	const ios = /iPad|iPhone|iPod/.test(userAgent)
		|| (platform === 'MacIntel' && maxTouchPoints > 1);
	return ios && /Safari/i.test(userAgent) && !/(CriOS|FxiOS|EdgiOS|OPiOS)/i.test(userAgent);
}
