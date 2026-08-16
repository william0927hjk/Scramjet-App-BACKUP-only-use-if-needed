importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

async function handleRequest(event) {
	const url = new URL(event.request.url);

	
	if (
		url.pathname.startsWith("/ai") ||
		url.pathname.startsWith("/chat") ||
		url.pathname.startsWith("/visitors") ||
		url.pathname.startsWith("/wisp") ||
		url.pathname.startsWith("/gfiles/")
	) {
		return fetch(event.request);
	}

	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		return scramjet.fetch(event);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
