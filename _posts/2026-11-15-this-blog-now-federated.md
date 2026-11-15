---
layout: post
title: 'This Blog is Now Federated: ActivityPub and AT Protocol'
author: Luke Bemish
description: Implementing ActivityPub and AT Protocol for a static site
---

While I'll admit to occasionally doomscrolling as much as anyone, historically I haven't actually posted much on short-form
social media sites. I've recently been trying to get back into photography after a few years of not really setting aside much
time for it, and as I was looking for platforms to post photos to other than Instagram, I realized that federated social
media is a thing and there are some Instagram alternatives that I like the look of that make use of it.

The "federated" in "federated social media" means that your photos/posts/etc. are hosted in one of any number of different
places in a decentralized fashion, but that there is a protocol by which those different places can talk to each other so
that users whose data is stored in one place can still see things going on elsewhere. [Mastodon](https://joinmastodon.org/)
and [Bluesky](https://bsky.app/) are both federated microblogging platforms like Twitter,[^1] but they use different
protocols, [ActivityPub](https://www.w3.org/TR/activitypub/) and [AT Protocol](https://atproto.com/) respectively, for federating, and since those protocols work in quite different ways
the ecosystems around the two have also ended up looking fairly different.

Since these protocols are pretty wide in their scope, there's nothing limiting them to short-form text.
[Pixelfed](https://pixelfed.org/) (based on ActivityPub) and [Zeens](https://zeens.app/) (based on AT Protocol) are platforms
meant mainly for image sharing, sort of like Instagram (though Zeens has more of a photography focus, with extensive support
built in for EXIF data).

In addition, there's nothing stopping you from using those protocols to distribute long-form content; plenty of tools out there
(including WordPress plugins) make it reasonably easy to have posts on your blog be federated with these protocols, either
for people to interact with directly from within other apps using the protocol or with dedicated browsers. I figured I'd
try and get that working on this blog.

[^1]: Yeah yeah, I guess it's "X" now or something...

## How this website Works

This blog is not a WordPress site, nor does it use any content management system with built-in support for either of these
protocols, so I needed to throw together my own solution. The actual protocols have specs (to varying degrees of
completeness, notes later...) that I could implement, but this site is completely static. It's hosted on GitHub Pages (in fact you can see the
source code that generates it [here](https://github.com/lukebemish/lukebemish.github.io)), and uses Jekyll, some ludicrously
overengineered Liquid templates, and some terrible shenanigans with custom Jekyll plugins to throw together the HTML that
GitHub serves. The whole thing is then behind Cloudflare's CDN.

Federation is handled by a separate service running under `blog.lukebemish.dev`. The Jekyll build of this site creates artifacts that
this service can watch, to see changes to post content or new posts, and then this service does
all the active bits necessary for federation. Since I've been trying to learn more Rust lately anyhow, I decided
to write this service in Rust using axum for HTTP routing; the source code is available [here](https://github.com/lukebemish/federated-blog).

## ActivityPub

ActivityPub is structured around "Objects", served as JSON-LD documents, where JSON-LD is just plain JSON with a `@context`
key which contains global identifiers for the schemas and vocabularies that the document uses. ActivityPub uses vocabulary
defined in the "ActivityStreams" protocol, so the JSON-LD has a link to that schema:

```json
{
    "@context": "https://www.w3.org/ns/activitystreams"
}
```

And it was at this point that I started to run into some pain. ActivityPub is designed in such a way that many reasonably core
features require extensions to the core ActivityStreams vocabulary. For instance, requests made by one backend to another need
to be signed, and the structure to share public key information for a user requires an extension!

It turns out that many implementors, even those that produce correct JSON-LD, basically ignore the JSON-LD-ness of what
they receive entirely, except for maybe validating that it actually _has_ a `@context`. Some barely even bother creating JSON-LD,
other than adding a minimal `@context` field. All of this to say actual support for JSON-LD in any form seems to be a bit sparse,
so I made a best effort to get it right and otherwise left it be.

The backend needs to serve JSON-LD files for every actor (me), other objects (a post), and activity (a post being made or updated,
a follow request being accepted, etc.; something an actor does to an object); each has an ID that is just its URL. In fact,
_everything_ has an ID that is just a URL. The list of followers an actor has? It's an object, with an ID. Each _page_ of
that list, since it needs to be paginated?[^3] You guessed it, also an object with an ID that is a URL that resolves it.

[^3]: The ActivityStreams spec does not _say_ that lists must be paginated, but some implementors (Mastodon) make assumptions
      that some, like an actor's followers list, are.

Most of this was reasonably easy to set up; I watch for changes to posts; I create new objects for new posts, update objects
as needed, and create activities for each creation or change I make. However, these activities need to be delivered to the
inboxes of my followers, and here I hit a bit of a snag. What ended up being a reasonably minor bug in how I was delivering
activities (I forgot to include a `@context` field in the activity as I delivered it, even though the dereferenced object
had it) ended up taking quite a lot of time to solve.

The flow for following an actor looks something like this:

1. Follower sends a `Follow` activity to the followee's inbox
2. Followee decides what to do with that; assuming they accept, they add the follower to their followers list
3. Followee sends an `Accept` activity referencing the original `Follow` activity back to the follower's inbox
4. Follower adds followee to their following list

Trying to follow my blog from my mastodon account, I had every step except 4 (the bit that happens on mastodon) working. My
server received my `Follow` request, added me to the followers list, responded with an `Accept` request, and the server
accepted that activity... and then seemingly did nothing with it. Why didn't it respond with a failure to my erroneous request?
Well, since ActivityPub is so reliant on extensions, and since JSON-LD as ActivityPub implementors use it doesn't include a
mechanism for validating the structure of an arbitrary JSON-LD document, servers need to return "successful" no-ops for unknown
activity types, and apparently mastodon also does for other types of invalid activities.

Anyways! With that last step out of the way, it all works and you should be able to follow this blog on the fediverse if you
choose, at `@blog@blog.lukebemish.dev`! It's hopefully far more reliable than the old mailing list I had (and definitely less
work to keep running than that system was).

## AT Protocol

The architecture of the AT Protocol looks quite different than ActivityPub at some level. An ActivityPub application generally
stores all of a user's data for that application, and represents them with an actor. While there are ways of moving from one
instance to another of the same application, this is more in the way of moving follower/followee lists and redirecting the old
to the new; it's not truly moving the whole old identity to a new instance.

AT Protocol instead gives a user one account, and one storage, that all AT Protocol applications talk to. All of a user's data
is stored in a Personal Data Server (PDS); this whole account can be transferred to a different PDS if desired. Since all the
data is stored in the same place, everything is much less fuzzy than ActivityPub's extensible Object syntax, while still being
quite extensible. Each record in your "repository" (the account stored on a PDS) has a `$type` referencing a lexicon, which is
a schema describing the form that data takes. JSON can be validated against lexica; there might be one lexicon for Bluesky
posts, one for Zeens posts, etc.; things interoperate insofar as they know about and read or write the same lexica.

The major lexicon for long-form content seems to be the [standard.site](https://standard.site/) lexica: `site.standard.publication`
for a website and then `site.standard.document` for a post. If your tool writes those to your repository, anything that knows
about them can see your posts. For instance, my blog posts will show up on [leaflet.pub](https://leaflet.pub/), which
uses these lexica, despite not writing them through that tool.

Compared to ActivityPub, support for AT Protocol was pretty easy to implement; this is mostly because I didn't have to make
a server that actually _does_ much; I took an off-the-shelf PDS implementation (Bluesky has one), ran it on my own computer
and moved my account to that, and then just had my service that watches for new posts make calls to my PDS to create/update
records for posts as necessary. The blog posts are attached to my normal `lukebemish.dev` AT Protocol handle.

## Closing thoughts

While neither of these protocols were too terribly difficult to implement, AT Protocol was definitely far easier to get working
with (and that's even given that I found a quite helpful Rust library that handled the worst of the heavy lifting for ActivityPub).
Of course this is because the worst part of it all — the federation — someone else implemented, but even beyond that there was
far less fussing around with data formats and figuring out whether what I was producing was sensible than with ActivityPub.
I didn't have to make a data structure, look at it, and then actually _send_ it to an ActivityPub server to test it;[^4] I could
just validate it against the lexicon.

AT Protocol is still quite extensible; if you need to represent a new kind of thing, you just define a new lexicon. If you
need to add data to an existing thing, you define a lexicon for that metadata that is strongly linked to the existing thing.
Of course, the tradeoff with this approach is that an application can't just store data in whatever format makes the most
sense for it in its own database; it needs to figure out how to represent it nicely with a lexicon. And relying on a single
PDS implementation from Bluesky, which does seem to be the major implementation, has its own disadvantages; you're stuck with
it and if it's weird it may not be easy to debug. Currently, I can't view any of my notifications from the Bluesky website
or app, though I can from elsewhere, due to an API method the website calls on me PDS raising an internal server error with no
useful reported stack trace.

This was a fun project, and I'm hoping to play around with AT Protocol and/or ActivityPub more in the future; among other
projects, I've put together [a gallery]({% link gallery.html %}) that pulls photos from my repository from my PDS and displays
them. Even if Zeens (the application that i used to post these photos, and who defines the relevant lexicon) were to completely
disappear, those photos would still be there and I could still serve them. This whole experiment is definitely not complete and
probably buggy as heck, and I'm sure I'll come back to it when I have some new weird idea, but I suppose that's just the fun of
having a website.

[^4]: [BrowserPub](https://browser.pub/) is a great tool that helped with this for validating objects as served; unfortunately,
      it's not super helpful for validating data as `POST`-ed to an inbox