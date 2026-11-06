require 'nokogiri'

module Jekyll
    module AbsoluteUrls
        def absolute_urls(input)
            fragment = Nokogiri::HTML5::DocumentFragment.parse(input)

            site = @context.registers[:site]
            baseurl = site.config['url']

            fragment.css('img').each do |img|
                absolute_item(baseurl, 'src', img)
            end

            fragment.css('a').each do |link|
                absolute_item(baseurl, 'href', link)
            end

            fragment.to_html.strip
        end

        private def absolute_item(baseurl, url_attr, item)
            src = item.attr(url_attr)

            uri = URI.parse(src)

            return unless uri.host.nil?

            new_uri = URI.join(baseurl, src)
            item.set_attribute(url_attr, new_uri)
        end
    end
end

Liquid::Template.register_filter(Jekyll::AbsoluteUrls)
