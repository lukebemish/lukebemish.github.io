---
---
const postsHolder = document.getElementById("posts-holder");

const sentinel = document.getElementById('scroll-sentinel');
const loadingText = document.getElementById('loading-text');

const collections = [
    "app.bsky.feed.post",
    "social.popfeed.feed.review",
    "app.zeens.post"
];

const cursors = {};

const pending = {};

const fetchMorePosts = async (collection) => {
    if (cursors[collection] === "") {
        return
    }
    const cursor_field = cursors[collection] === undefined ? "" : "&cursor="+cursors[collection];
    const found = await window.fetch(
        `{{ site.atproto.pds }}xrpc/com.atproto.repo.listRecords?repo={{ site.atproto.did }}&collection=${collection}&limit=20`+cursor_field
    );
    const body = await found.json();
    if (body.cursor === undefined) {
        cursors[collection] = "";
    } else {
        cursors[collection] = body.cursor;
    }
    const posts = body.records;
    if (pending[collection] === undefined) {
        pending[collection] = [];
    }
    for (const post of posts) {
        post.createdAt = Date.parse(post.value.createdAt);
        pending[collection].push(post);
    }
}

let noMorePosts = false;
const getNextPost = async () => {
    if (noMorePosts) {
        return undefined;
    }

    let lowestdate = undefined;
    let lowestkey = undefined;
    for (const key of collections) {
        if (pending[key] === undefined || pending[key].length === 0) {
            await fetchMorePosts(key);
        }
        if (pending[key] === undefined || pending[key].length === 0) {
            continue;
        }
        let post = pending[key][0];
        if (lowestdate === undefined) {
            lowestdate = post.createdAt;
        }
        if (post.createdAt >= lowestdate) {
            lowestkey = key;
            lowestdate = post.createdAt;
        }
    }
    if (lowestkey !== undefined) {
        return [lowestkey, pending[lowestkey].shift()];
    } else {
        noMorePosts = true;
        return undefined;
    }
};

const getRecord = async (did, collection, rkey) => {
    const found = await window.fetch(
        `{{ site.atproto.pds }}xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`
    );
    return await found.json();
}

const profiles = {};
const getProfile = async (did) => {
    if (profiles[did] !== undefined) {
        return profiles[did];
    }
    const found = await window.fetch(
        `{{ site.atproto.pds }}xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.actor.profile&rkey=self`
    );
    if (!found.ok) {
        profiles[did] = {
            name: "Unknown"
        };
        return profiles[did];
    }
    try {
        const body = await found.json();
        const name = body?.value?.displayName ?? "Unknown";
        const avatar_ref = body?.value?.avatar?.ref?.$link;
        const out = {
            name: name
        };
        if (avatar_ref !== undefined) {
            out.avatar = `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${avatar_ref}`
        }
        profiles[did] = out;
        return profiles[did];
    } catch {
        profiles[did] = {
            name: "Unknown"
        };
        return profiles[did];
    }
};

const permalink = (did) => {
    if ("{{ site.atproto.did }}" === did) {
        return "{{ site.authors[site.author].permalink }}";
    } else {
        return `https://bsky.app/profile/${did}`;
    }
}

const formatPost = async (did, key, post) => {
    const decoder = new TextDecoder();
    const plainText = (bytes) => {
        const element = document.createElement("span");
        element.textContent = decoder.decode(bytes);
        element.style.whiteSpace = "pre-wrap"
        return element;
    }

    // Shared logic:
    if (post.value?.reply !== undefined) {
        return undefined;
    }

    const facets = post.value.facets ?? [];
    facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
    const bytes = new TextEncoder().encode(post.value.text);
    const elementsOut = [];

    if (key == "social.popfeed.feed.review") {
        // Add the poster
        const img = document.createElement("img");
        const ref = post.value.poster.ref.$link;
        img.setAttribute("src", `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${ref}`);
        img.style.width = "70px";
        img.style.objectFit = "contain";

        const poster = document.createElement("div");
        poster.style.display = "flex";
        poster.style.gap = "calc(var(--spacing) * 4)";
        poster.style.flexDirection = "row";
        poster.appendChild(img);
        elementsOut.push(poster);

        const date = new Date(post.value.releaseDate);
        const title = post.value.title;
        const credit = post.value.mainCredit;

        const details = document.createElement("div");
        details.style.display = "flex";
        details.style.flexDirection = "row";
        const when = document.createElement("time");
        when.setAttribute("datetime", date.toISOString());
        when.textContent = date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric"
        });
        const whenSpan = document.createElement("small");
        whenSpan.appendChild(when);
        details.appendChild(whenSpan);

        const titleSpan = document.createElement("h2");
        titleSpan.textContent = title;
        details.appendChild(titleSpan);

        const creditSpan = document.createElement("strong");
        creditSpan.textContent = credit;
        details.appendChild(creditSpan);

        details.style.flexGrow = "1";

        poster.appendChild(details);
        poster.classList.add("review-poster");

        let rating = post.value.rating;

        const star = `{% fontawesome "solid", "star" %}`;
        const half_star = `{% fontawesome "solid", "star-half-stroke" %}`;
        const empty_star = `{% fontawesome "regular", "star" %}`;
        let ratingString = "";
        for (let i = 0; i < 10; i += 2) {
            if (rating > 1) {
                ratingString += star;
            } else if (rating == 1) {
                ratingString += half_star;
            } else {
                ratingString += empty_star;
            }
            rating -= 2;
        }

        const ratingDiv = document.createElement("div");
        const ratingSmall = document.createElement("small");
        ratingDiv.appendChild(ratingSmall);
        elementsOut.push(ratingDiv);
        ratingSmall.innerHTML = ratingString;
        ratingDiv.classList.add("review-ratings");
        for (const child of ratingSmall.querySelectorAll("svg")) {
            child.classList.add("font-awesome-icon");
        }
    }

    let byteAt = 0;
    for (const facet of facets) {
        if (facet.index.byteStart < byteAt) {
            continue; // some posts have these; just ignore them
        }
        elementsOut.push(plainText(bytes.slice(byteAt, facet.index.byteStart)));

        let inner = plainText(bytes.slice(facet.index.byteStart, facet.index.byteEnd));

        for (const feature of facet.features) {
            if (feature.$type === "app.bsky.richtext.facet#link") {
                const inner_old = inner;
                inner = document.createElement("a");
                inner.setAttribute("href", feature.uri);
                inner.setAttribute("target", "_blank");
                inner.appendChild(inner_old);
            }
            if (feature.$type === "app.bsky.richtext.facet#mention") {
                const inner_old = inner;
                inner = document.createElement("a");
                inner.setAttribute("href", permalink(feature.did));
                inner.setAttribute("target", "_blank");
                inner.appendChild(inner_old);
            }
            if (feature.$type === "app.bsky.richtext.facet#tag") {
                const inner_old = inner;
                inner = document.createElement("a");
                inner.setAttribute("href", `https://bsky.app/hashtag/${feature.tag}`);
                inner.setAttribute("target", "_blank");
                inner.appendChild(inner_old);
            }
        }

        elementsOut.push(inner);

        byteAt = facet.index.byteEnd;
    }
    elementsOut.push(plainText(bytes.slice(byteAt, bytes.length)));

    if (post.value.embed !== undefined) {
        const embed = post.value.embed;
        if (embed.$type == "app.bsky.embed.record") {
            if (embed.record.uri !== undefined) {
                // View record
                const regex = /^at:\/\/(?<did>[^/]+)\/(?<collection>[^/]+)\/(?<rkey>[^/]+)$/;
                const match = embed.record.uri.match(regex);
                const embed_did = match.groups["did"];
                const embed_collection = match.groups["collection"];
                const embed_rkey = match.groups["rkey"];
                if (collections.includes(embed_collection)) {
                    const inner_post = await getRecord(embed_did, embed_collection, embed_rkey);
                    const rendered_inner = await formatPost(embed_did, embed_collection, inner_post);
                    rendered_inner.classList.add("embed");
                    elementsOut.push(rendered_inner);
                }
            }
        } else if (embed.$type == "app.bsky.embed.images") {
            const image_row = document.createElement("div");
            for (const image of embed.images) {
                const img = document.createElement("img");
                const ref = image.image.ref.$link;
                img.setAttribute("src", `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${ref}`);
                if (image.aspectRatio !== undefined) {
                    img.style.aspectRatio = `${image.aspectRatio.width}/${image.aspectRatio.height}`;
                }
                if (image.alt !== undefined) {
                    img.alt = image.alt;
                }
                if (embed.images.length > 1) {
                    img.style.width = "auto";
                    img.style.height = "50cqw";
                }
                image_row.appendChild(img);
            }
            image_row.classList.add("image-row")
            elementsOut.push(image_row);
        }
    }

    const holder = document.createElement("div");
    for (const element of elementsOut) {
        holder.appendChild(element);
    }

    const header = document.importNode(document.getElementById("post-header").content, true);
    const createdAtDate = new Date(post.value.createdAt);
    header.querySelector(".post-header-time").setAttribute("datetime", createdAtDate.toISOString());
    header.querySelector(".post-header-time").textContent = createdAtDate.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
    const profile = await getProfile(did);
    header.querySelector(".post-header-name").textContent = profile.name;
    header.querySelector(".post-header-name").setAttribute("href", permalink(did));
    if (profile.avatar !== undefined) {
        header.querySelector(".post-header-image").setAttribute("src", profile.avatar);
    }

    let share_name = "";
    let share_link = "";
    let share_symbol = "";
    console.log(post);
    const regex = /^at:\/\/(?<did>[^/]+)\/(?<collection>[^/]+)\/(?<rkey>[^/]+)$/;
    const match = post.uri.match(regex);
    const rkey = match.groups["rkey"];
    if (key == "app.bsky.feed.post") {
        share_name = "Bluesky";
        share_symbol = `{% fontawesome "brands", "bluesky" %} `;
        share_link = `https://bsky.app/profile/${did}/post/${rkey}`;
    } else if (key == "social.popfeed.feed.review") {
        share_name = "Popfeed";
        share_link = `https://popfeed.social/review/at:/${did}/social.popfeed.feed.review/${rkey}`
    } else {
        share_name = "Zeens";
        share_link = `https://zeens.app/profile/${did}/post/${rkey}`;
    }
    header.querySelector(".post-header-view-name").textContent = share_name;
    header.querySelector(".post-header-view-symbol").innerHTML = share_symbol;
    header.querySelector(".post-header-view-link").setAttribute("href", share_link)

    const postElement = document.createElement("div");
    postElement.appendChild(header);
    postElement.appendChild(holder);

    return postElement;
};

let isLoading = false;
const getMorePosts = async () => {
    if (isLoading || noMorePosts) return;
    isLoading = true;
    loadingText.style.display = 'block';

    try {
        const nextPost = await getNextPost();
        if (nextPost === undefined) return;
        const [key, post] = nextPost;
        if (post === undefined) return;
        let postContent = await formatPost("{{ site.atproto.did }}", key, post);
        if (postContent === undefined) return;
        postsHolder.appendChild(postContent);
    } catch (e) {
        console.error(e);
    } finally {
        loadingText.style.display = "none";
        isLoading = false;
    }
}

let isAdding = false;
const observer = new IntersectionObserver(
    async (entries) => {
        if (!isAdding && !noMorePosts && entries[entries.length - 1].isIntersecting) {
            observer.unobserve(sentinel);
            isAdding = true;
            await getMorePosts();
            isAdding = false;
            observer.observe(sentinel);
        }
    },
    {
        root: null,
        rootMargin: '500px',
        threshold: 0.1
    }
);

observer.observe(sentinel);
