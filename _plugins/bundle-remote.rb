require "digest"
require "mime/types"
require 'jekyll/document'
require 'fileutils'

module BundleRemote
    class NonReplacingStaticFile < Jekyll::StaticFile
        def write(dest)
            true
        end
    end

    class RemoteBundler < Liquid::Tag
        def initialize(tag_name, text, tokens)
            parsed = Liquid::Variable.new(text.strip, tokens)
            @contents = parsed
        end

        def render(context)
            parsed = @contents.render(context).strip
            uri = URI(parsed)
            https = Net::HTTP.new(uri.host, uri.port)
            https.use_ssl = true
            response = https.get(uri.path)
            mimetype = MIME::Types[response.content_type].first

            site = context.registers[:site]
            Dir::mkdir(File.join(site.dest, "bundled")) if !File.directory? File.join(site.dest, "bundled")
            page = NonReplacingStaticFile.new(
                site,
                site.dest,
                "bundled",
                Digest::SHA256.hexdigest(parsed) + "." + mimetype.preferred_extension
            )
            dest = File.join(
                site.dest,
                "bundled",
                Digest::SHA256.hexdigest(parsed) + "." + mimetype.preferred_extension
            )
            f = File.new(dest, 'w')
            f.write(response.body)
            f.close
            site.static_files << page
            "/" + page.url.to_s
        end
    end
end

Liquid::Template.register_tag('bundleremote', BundleRemote::RemoteBundler)
