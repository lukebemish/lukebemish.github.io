require 'nokogiri'

module Jekyll
    module AbsoluteUrls
        def minify_html(input)
            fragment = Nokogiri::HTML5::DocumentFragment.parse(input)
            protected_elements = %w[pre textarea code script style]
            processor = ->(text_node) do
                minified_text = text_node.content.gsub(/[\r\n\s]+/, ' ')
                text_node.content = minified_text
                if (minified_text.match?(/\A[\r\n\s]+\z/))
                    text_node.remove()
                end
            end
            xpath_query = ".//text()[not(ancestor::#{protected_elements.join(' or ancestor::')})]"
            fragment.xpath(xpath_query).each(&processor)
            xpath_query = "./text()[not(ancestor::#{protected_elements.join(' or ancestor::')})]"
            fragment.xpath(xpath_query).each(&processor)

            # 3. Serialize back to HTML string, stripping out extra indentation
            fragment.to_html(indent: 0).strip
        end

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
