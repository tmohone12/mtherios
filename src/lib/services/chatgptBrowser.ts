let csrf='';
export function setChatgptCsrf(value:string){csrf=value;}
export function chatgptCsrfHeaders():Record<string,string>{return csrf?{'X-MythEngine-CSRF':csrf}:{};}
