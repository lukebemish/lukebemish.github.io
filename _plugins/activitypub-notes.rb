module ActivityPubSupport
    class Generator < Jekyll::Generator
        safe true
        priority :lowest

        def generate(site)
            site.posts.docs.each do |post|
                newpage = NotesPage.new(site, post)
                site.pages << newpage
                post.data["activitypub-note"] = newpage
            end
        end
    end

    class NotesPage < Jekyll::Page
        def initialize(site, post)
            @site = site
            post_url = post.url.to_s
            if post_url.end_with? "/"
                post_url = post_url.chop
            end
            @dir = File.dirname(post_url)
            @base = site.source

            @basename = File.basename(post_url, ".*")
            @ext      = '.jsonld'
            @name     = File.basename(post_url, ".*") + '.jsonld'

            # Initialize data hash with a key pointing to all posts under current category.
            # This allows accessing the list in a template via `page.linked_docs`.
            @data = {
                'linked_post' => post.url.to_s,
                'layout' => 'activitypub_note'
            }

            # Look up front matter defaults scoped to type `categories`, if given key
            # doesn't exist in the `data` hash.
            data.default_proc = proc do |_, key|
                site.frontmatter_defaults.find(relative_path, :posts, key)
            end
        end
  end
end