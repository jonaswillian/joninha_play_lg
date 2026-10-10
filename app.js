/* Joninha's Play - IPTV Pro (LG webOS 1.0.6 Compatible) */

const PAGE_SIZE = 48;
const SPLASH_MS = 2500;

const KEY = {
	LEFT: 37,
	UP: 38,
	RIGHT: 39,
	DOWN: 40,
	ENTER: 13,
	ESC: 27,
	BACK: 461,
	PGUP: 33,
	PGDN: 34,
	CH_UP: 427,
	CH_DOWN: 428,
	PAUSE: 19,
	STOP: 413,
	REW: 412,
	PLAY: 415,
	FF: 417,
};

const TITLES = { live: "TV ao Vivo", movies: "Filmes", series: "Séries" };

const state = {
	serverUrl: "",
	username: "",
	password: "",
	currentType: "live",
	dataCache: { live: null, movies: null, series: null },
	categories: { live: [], movies: [], series: [] },
	currentCategory: "all",
	searchTerm: "",
	currentEpisodes: {},
	currentList: [],
	renderedCount: 0,
	playerReturn: "main",
	lastFocus: null,
	isLivePlaying: false,
	currentChannelEPG: null,
};

const loader = document.getElementById("global-loader");
const videoPlayer = document.getElementById("main-video");
const grid = document.getElementById("content-grid");
const catList = document.getElementById("category-list");
const modal = document.getElementById("series-modal");

function showLoader(show) {
	loader.style.display = show ? "block" : "none";
}

function switchScreen(fromId, toId) {
	document.getElementById(fromId).classList.remove("active");
	document.getElementById(toId).classList.add("active");
}

function screenActive(id) {
	return document.getElementById(id).classList.contains("active");
}

function isModalOpen() {
	return modal.style.display === "block";
}

function isPlayerActive() {
	return screenActive("player-screen");
}

function normalizeUrl(url) {
	url = url.trim();
	if (!/^https?:\/\//i.test(url)) url = "http://" + url;
	return url.replace(/\/+$/, "");
}

function apiUrl(action, extra) {
	let url =
		state.serverUrl +
		"/player_api.php?username=" +
		encodeURIComponent(state.username) +
		"&password=" +
		encodeURIComponent(state.password);
	if (action) url += "&action=" + action;
	if (extra) url += extra;
	return url;
}

function fetchJson(url, ms) {
	return Promise.race([
		fetch(url).then(r => r.json()),
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("timeout")), ms || 45000),
		),
	]);
}

function exitApp() {
	if (window.webOS && typeof window.webOS.platformBack === "function") {
		window.webOS.platformBack();
	} else {
		window.close();
	}
}

/* DECODIFICAÇÃO UTF-8 CORRETA PARA BASE64 (Acentos resolvidos) */
function decodeBase64Safe(str) {
	if (!str) return "";
	try {
		return decodeURIComponent(escape(atob(str)));
	} catch (e) {
		try {
			return atob(str);
		} catch (err) {
			return str;
		}
	}
}

/* Auth & Init */

window.addEventListener("DOMContentLoaded", async () => {
	const savedUrl = localStorage.getItem("xp_url");
	const savedUser = localStorage.getItem("xp_user");
	const savedPass = localStorage.getItem("xp_pass");

	if (savedUrl) document.getElementById("url").value = savedUrl;
	if (savedUser) document.getElementById("user").value = savedUser;
	if (savedPass) document.getElementById("pass").value = savedPass;

	const splashDelay = new Promise(resolve => setTimeout(resolve, SPLASH_MS));

	const authPromise = (async () => {
		if (!(savedUrl && savedUser && savedPass)) return false;
		state.serverUrl = normalizeUrl(savedUrl);
		state.username = savedUser;
		state.password = savedPass;
		return await authenticateXtream();
	})();

	const results = await Promise.all([authPromise, splashDelay]);

	if (results[0]) {
		enterMain("splash-screen");
	} else {
		switchScreen("splash-screen", "login-screen");
		document.getElementById("url").focus();
	}
});

document.getElementById("login-btn").addEventListener("click", async () => {
	const url = document.getElementById("url").value.trim();
	state.username = document.getElementById("user").value.trim();
	state.password = document.getElementById("pass").value.trim();

	if (!url || !state.username || !state.password) {
		alert("Preencha todos os campos do formulário!");
		return;
	}
	state.serverUrl = normalizeUrl(url);

	showLoader(true);
	const ok = await authenticateXtream();
	showLoader(false);

	if (ok) {
		localStorage.setItem("xp_url", state.serverUrl);
		localStorage.setItem("xp_user", state.username);
		localStorage.setItem("xp_pass", state.password);
		enterMain("login-screen");
	} else {
		alert("Falha na conexão. Verifique seus dados.");
	}
});

function enterMain(fromScreen) {
	switchScreen(fromScreen, "main-screen");
	loadCategory("live");
	const tab = document.querySelector(".nav-btn.active-tab");
	if (tab) tab.focus();
}

async function authenticateXtream() {
	try {
		const data = await fetchJson(apiUrl(), 15000);
		return !!(data.user_info && Number(data.user_info.auth) === 1);
	} catch (e) {
		console.error(e);
		return false;
	}
}

/* Categorias */

document.querySelectorAll(".nav-btn[data-type]").forEach(btn => {
	btn.addEventListener("click", () => {
		document
			.querySelectorAll(".nav-btn[data-type]")
			.forEach(b => b.classList.remove("active-tab"));
		btn.classList.add("active-tab");
		document.getElementById("search-input").value = "";
		loadCategory(btn.getAttribute("data-type"));
	});
});

let searchTimer = null;
document.getElementById("search-input").addEventListener("input", e => {
	const term = e.target.value.toLowerCase().trim();
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		state.searchTerm = term;
		applyFilter();
	}, 300);
});

async function loadCategory(type) {
	state.currentType = type;
	state.currentCategory = "all";
	state.searchTerm = "";

	grid.innerHTML = "";
	catList.innerHTML = "";
	document.getElementById("category-title").innerText = TITLES[type];
	document.getElementById("category-count").innerText = "";
	document.getElementById("epg-panel").style.display =
		type === "live" ? "block" : "none";

	if (state.dataCache[type] === null) {
		const actions = {
			live: ["get_live_streams", "get_live_categories"],
			movies: ["get_vod_streams", "get_vod_categories"],
			series: ["get_series", "get_series_categories"],
		};

		showLoader(true);
		try {
			const res = await Promise.all([
				fetchJson(apiUrl(actions[type][0]), 120000),
				fetchJson(apiUrl(actions[type][1]), 30000).catch(() => []),
			]);
			state.dataCache[type] = Array.isArray(res[0]) ? res[0] : [];
			state.categories[type] = Array.isArray(res[1]) ? res[1] : [];
		} catch (e) {
			console.error(e);
			state.dataCache[type] = null;
			alert("Erro ao carregar os dados.");
		}
		showLoader(false);
	}

	if (state.currentType !== type || state.dataCache[type] === null) return;

	renderCategories();
	applyFilter();
}

function renderCategories() {
	const type = state.currentType;
	const items = state.dataCache[type] || [];

	const counts = {};
	for (let i = 0; i < items.length; i++) {
		const id = String(items[i].category_id);
		counts[id] = (counts[id] || 0) + 1;
	}

	const list = [{ id: "all", name: "Todos", count: items.length }];
	state.categories[type].forEach(c => {
		const id = String(c.category_id);
		if (counts[id])
			list.push({ id: id, name: c.category_name, count: counts[id] });
	});

	catList.innerHTML = "";
	const frag = document.createDocumentFragment();
	list.forEach(c => {
		const btn = document.createElement("button");
		btn.className =
			"cat-item focusable" +
			(c.id === state.currentCategory ? " active-cat" : "");

		const name = document.createElement("span");
		name.className = "cat-title";
		name.innerText = c.name;

		const badge = document.createElement("span");
		badge.className = "cat-badge";
		badge.innerText = c.count;

		btn.appendChild(name);
		btn.appendChild(badge);

		btn.addEventListener("click", () => {
			state.currentCategory = c.id;
			state.searchTerm = "";
			document.getElementById("search-input").value = "";
			document
				.querySelectorAll(".cat-item")
				.forEach(el => el.classList.remove("active-cat"));
			btn.classList.add("active-cat");
			applyFilter();
		});
		frag.appendChild(btn);
	});
	catList.appendChild(frag);
}

function applyFilter() {
	const type = state.currentType;
	const all = state.dataCache[type] || [];
	let items = all;
	let label = TITLES[type];

	if (state.searchTerm) {
		items = all.filter(
			i => i.name && i.name.toLowerCase().indexOf(state.searchTerm) !== -1,
		);
		label = TITLES[type] + " — Busca";
	} else if (state.currentCategory !== "all") {
		const cat = state.currentCategory;
		items = all.filter(i => String(i.category_id) === cat);
		const found = state.categories[type].find(
			c => String(c.category_id) === cat,
		);
		if (found) label = TITLES[type] + " — " + found.category_name;
	}

	document.getElementById("category-title").innerText = label;
	document.getElementById("category-count").innerText = items.length + " itens";
	renderGrid(items, type);
}

function renderGrid(items, type) {
	state.currentList = items;
	state.renderedCount = 0;
	grid.innerHTML = "";
	grid.scrollTop = 0;
	grid.className =
		"grid-container " + (type === "live" ? "live-mode" : "poster-mode");

	if (items.length === 0) {
		grid.innerHTML =
			'<div class="empty-state">Nenhum conteúdo disponível nesta categoria.</div>';
		return;
	}
	renderMore();
}

function hasMore() {
	return state.renderedCount < state.currentList.length;
}

function renderMore() {
	if (!hasMore()) return;
	const end = Math.min(
		state.renderedCount + PAGE_SIZE,
		state.currentList.length,
	);
	const frag = document.createDocumentFragment();
	for (let i = state.renderedCount; i < end; i++) {
		frag.appendChild(createCard(state.currentList[i], state.currentType, i));
	}
	state.renderedCount = end;
	grid.appendChild(frag);
}

/* CONSULTA EPG E ATUALIZAÇÃO DO OVERLAY */

async function fetchEPG(streamId, name) {
	const titleHeader = document.getElementById("epg-channel-title");
	const scheduleList = document.getElementById("epg-schedule-list");
	titleHeader.innerText = name;
	scheduleList.innerHTML =
		'<div class="epg-item"><div class="epg-item-title">Carregando guia...</div></div>';

	try {
		const epgData = await fetchJson(
			apiUrl(
				"get_short_epg",
				"&stream_id=" + encodeURIComponent(streamId) + "&limit=10",
			),
			8000,
		);
		scheduleList.innerHTML = "";

		if (epgData && epgData.epg_listings && epgData.epg_listings.length > 0) {
			state.currentChannelEPG = epgData.epg_listings;

			epgData.epg_listings.forEach((prog, index) => {
				const item = document.createElement("div");
				item.className = "epg-item" + (index === 0 ? " current" : "");

				const pTitle = decodeBase64Safe(prog.title);
				const start = prog.start ? prog.start.substring(11, 16) : "--:--";
				const end = prog.end ? prog.end.substring(11, 16) : "--:--";

				item.innerHTML =
					'<div class="epg-item-time">' +
					start +
					" - " +
					end +
					'</div><div class="epg-item-title">' +
					(pTitle || "Programa") +
					"</div>";
				scheduleList.appendChild(item);
			});
		} else {
			scheduleList.innerHTML =
				'<div class="epg-item"><div class="epg-item-title">Guia indisponível para este canal.</div></div>';
			state.currentChannelEPG = null;
		}
	} catch (e) {
		scheduleList.innerHTML =
			'<div class="epg-item"><div class="epg-item-title">Sem guia de programação.</div></div>';
		state.currentChannelEPG = null;
	}
}

/* CARDS E TRATAMENTO SEGURO DAS IMAGENS */

function createCard(item, type, idx) {
	const card = document.createElement("div");
	card.className = "media-card focusable";
	card.tabIndex = 0;
	card._idx = idx;

	const poster = document.createElement("div");
	poster.className = "card-poster";

	const fallback = document.createElement("div");
	fallback.className = "poster-fallback";
	fallback.innerText = (item.name || "?").trim().charAt(0).toUpperCase();
	poster.appendChild(fallback);

	const imgUrl = item.stream_icon || item.cover;
	if (imgUrl) {
		const img = document.createElement("img");
		img.style.display = "block";
		img.onerror = function () {
			this.style.display = "none";
		};
		img.src = imgUrl;
		poster.appendChild(img);
	}

	const info = document.createElement("div");
	info.className = "card-info";
	const title = document.createElement("div");
	title.className = "title";
	title.innerText = item.name || "Sem título";
	info.appendChild(title);

	card.appendChild(poster);
	card.appendChild(info);

	card.addEventListener("focus", () => {
		if (type === "live") {
			fetchEPG(item.stream_id, item.name);
		}
	});

	card.addEventListener("click", () => {
		state.lastFocus = card;
		if (type === "series") {
			openSeriesModal(item.series_id, item.name);
		} else {
			state.playerReturn = "main";
			playMedia(item.stream_id, type, item.container_extension, item.name);
		}
	});

	return card;
}

/* Séries */

async function openSeriesModal(seriesId, seriesName) {
	showLoader(true);
	try {
		const data = await fetchJson(
			apiUrl("get_series_info", "&series_id=" + encodeURIComponent(seriesId)),
			30000,
		);
		const episodes = data.episodes || {};
		state.currentEpisodes = episodes;

		const seasonKeys = Object.keys(episodes).sort(
			(a, b) => Number(a) - Number(b),
		);

		if (seasonKeys.length === 0) {
			showLoader(false);
			alert("Sem episódios para esta série.");
			return;
		}

		document.getElementById("modal-series-title").innerText = seriesName;
		const seasonsContainer = document.getElementById("seasons-container");
		seasonsContainer.innerHTML = "";

		seasonKeys.forEach(key => {
			const btn = document.createElement("button");
			btn.className = "nav-btn focusable";
			btn.innerText = "Temporada " + key + " (" + episodes[key].length + ")";
			btn.addEventListener("click", () => {
				seasonsContainer
					.querySelectorAll(".nav-btn")
					.forEach(b => b.classList.remove("active-tab"));
				btn.classList.add("active-tab");
				renderEpisodes(key);
			});
			seasonsContainer.appendChild(btn);
		});

		modal.style.display = "block";
		const first = seasonsContainer.firstChild;
		if (first) {
			first.classList.add("active-tab");
			renderEpisodes(seasonKeys[0]);
			first.focus();
		}
	} catch (e) {
		alert("Erro ao carregar detalhes da série.");
	}
	showLoader(false);
}

function renderEpisodes(seasonKey) {
	const container = document.getElementById("episodes-container");
	container.innerHTML = "";

	const episodes = state.currentEpisodes[seasonKey] || [];
	episodes.forEach(ep => {
		const card = document.createElement("div");
		card.className = "episode-card focusable";
		card.tabIndex = 0;
		card.innerText = "Ep. " + ep.episode_num + " - " + (ep.title || "Episódio");

		card.addEventListener("click", () => {
			state.playerReturn = "modal";
			state.lastFocus = card;
			playMedia(ep.id, "series", ep.container_extension, ep.title);
		});
		container.appendChild(card);
	});
}

/* Player */

function playMedia(id, type, ext, mediaTitle) {
	const base = state.serverUrl;
	const cred =
		encodeURIComponent(state.username) +
		"/" +
		encodeURIComponent(state.password);
	let streamUrl = "";

	if (type === "live") streamUrl = base + "/live/" + cred + "/" + id + ".ts";
	else if (type === "movies")
		streamUrl = base + "/movie/" + cred + "/" + id + "." + (ext || "mp4");
	else if (type === "series")
		streamUrl = base + "/series/" + cred + "/" + id + "." + (ext || "mp4");

	if (!streamUrl) return;

	state.isLivePlaying = type === "live";
	if (isModalOpen()) modal.style.display = "none";

	const playerEpg = document.getElementById("player-epg");
	if (type === "live") {
		playerEpg.style.display = "block";
		document.getElementById("player-channel-name").innerText =
			mediaTitle || "Canal ao Vivo";

		let text = "Sem informação de guia";
		if (state.currentChannelEPG && state.currentChannelEPG.length > 0) {
			const prog = state.currentChannelEPG[0];
			text = "Agora: " + decodeBase64Safe(prog.title);
		}
		document.getElementById("player-epg-text").innerText = text;

		setTimeout(() => {
			playerEpg.style.display = "none";
		}, 5000);
	} else {
		playerEpg.style.display = "none";
	}

	switchScreen("main-screen", "player-screen");
	videoPlayer.src = streamUrl;
	videoPlayer.play().catch(e => console.error(e));
}

function closePlayer() {
	videoPlayer.pause();
	videoPlayer.removeAttribute("src");
	videoPlayer.load();
	switchScreen("player-screen", "main-screen");

	if (state.playerReturn === "modal") {
		modal.style.display = "block";
	}
	if (state.lastFocus && state.lastFocus.offsetParent !== null) {
		state.lastFocus.focus();
	}
}

/* Voltar e Teclado */

function goBack() {
	if (screenActive("splash-screen")) return;

	if (isPlayerActive()) {
		closePlayer();
		return;
	}

	if (isModalOpen()) {
		modal.style.display = "none";
		if (state.lastFocus) state.lastFocus.focus();
		return;
	}

	if (screenActive("main-screen")) {
		const activeEl = document.activeElement;
		if (activeEl && grid.contains(activeEl)) {
			const currentCat = document.querySelector(".cat-item.active-cat");
			if (currentCat) currentCat.focus();
			return;
		}
		if (activeEl && catList.contains(activeEl)) {
			const currentTab = document.querySelector(".nav-btn.active-tab");
			if (currentTab) currentTab.focus();
			return;
		}
		exitApp();
		return;
	}

	exitApp();
}

function navigate(dir) {
	const scope = isModalOpen()
		? modal
		: document.querySelector(".screen.active");
	if (!scope) return;

	const candidates = Array.from(scope.querySelectorAll(".focusable")).filter(
		el => el.offsetParent !== null,
	);
	if (candidates.length === 0) return;

	const current = candidates.includes(document.activeElement)
		? document.activeElement
		: null;
	if (!current) {
		candidates[0].focus();
		return;
	}

	const cRect = current.getBoundingClientRect();
	const cx = cRect.left + cRect.width / 2;
	const cy = cRect.top + cRect.height / 2;

	let best = null;
	let minScore = Infinity;

	candidates.forEach(el => {
		if (el === current) return;
		const r = el.getBoundingClientRect();
		const dx = r.left + r.width / 2 - cx;
		const dy = r.top + r.height / 2 - cy;

		let main, cross;
		if (dir === "right") {
			if (dx <= 5) return;
			main = dx;
			cross = Math.abs(dy);
		} else if (dir === "left") {
			if (dx >= -5) return;
			main = -dx;
			cross = Math.abs(dy);
		} else if (dir === "down") {
			if (dy <= 5) return;
			main = dy;
			cross = Math.abs(dx);
		} else if (dir === "up") {
			if (dy >= -5) return;
			main = -dy;
			cross = Math.abs(dx);
		}

		const score = main + cross * 2.5;
		if (score < minScore) {
			minScore = score;
			best = el;
		}
	});

	if (!best && dir === "down" && grid.contains(current) && hasMore()) {
		renderMore();
		navigate(dir);
		return;
	}

	if (best) best.focus();
}

document.addEventListener("keydown", e => {
	const k = e.keyCode;

	if (k === KEY.BACK || k === KEY.ESC) {
		e.preventDefault();
		e.stopPropagation();
		goBack();
		return;
	}

	if (screenActive("splash-screen")) return;

	if (isPlayerActive()) {
		if (k === KEY.ENTER || k === KEY.PAUSE || k === KEY.PLAY) {
			e.preventDefault();
			if (videoPlayer.paused) videoPlayer.play();
			else videoPlayer.pause();
		} else if (k === KEY.STOP) {
			closePlayer();
		} else if (k === KEY.LEFT || k === KEY.REW) {
			if (!state.isLivePlaying)
				videoPlayer.currentTime = Math.max(0, videoPlayer.currentTime - 10);
		} else if (k === KEY.RIGHT || k === KEY.FF) {
			if (!state.isLivePlaying) videoPlayer.currentTime += 10;
		}
		return;
	}

	if ([KEY.LEFT, KEY.RIGHT, KEY.UP, KEY.DOWN].includes(k)) {
		const el = document.activeElement;
		if (el && el.tagName === "INPUT") {
			if (k === KEY.LEFT && el.selectionStart !== 0) return;
			if (k === KEY.RIGHT && el.selectionEnd !== el.value.length) return;
		}
		e.preventDefault();
		const map = { 37: "left", 38: "up", 39: "right", 40: "down" };
		navigate(map[k]);
		return;
	}

	if (k === KEY.ENTER) {
		const el = document.activeElement;
		if (
			el &&
			el.classList.contains("focusable") &&
			el.tagName !== "INPUT" &&
			el.tagName !== "BUTTON"
		) {
			e.preventDefault();
			el.click();
		}
	}
});
