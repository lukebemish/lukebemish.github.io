require 'liquid/variable'
require 'net/http'

module FontAwesomeSupport
    class FontAwesome < Liquid::Tag
        def initialize(tag_name, text, tokens)
            super
            regex = /^(?'first'[^(,]*(?'expr'[^()]+|\([^()]*(\g'expr')?[^()]*\)))\s*,\s*(?'second'[^(,]*(\g'expr'))$/
            if matches = text.strip.match(regex)
                @category = Liquid::Variable.new(matches[:first], tokens)
                @name = Liquid::Variable.new(matches[:second], tokens)
            else
                raise "Text '#{text}' did not contain two variables"
            end
        end

        @@spritesheets = Hash.new { |hash, key|
            uri = URI("https://cdnjs.cloudflare.com/ajax/libs/font-awesome/7.3.1/sprites/#{key}.svg")
            https = Net::HTTP.new(uri.host, uri.port)
            https.use_ssl = true
            response = https.get(uri.path)
            hash[key] = response.body
        }

        private def sprites(category)
            @@spritesheets[category]
        end

        def render(context)
            version = context.registers[:site].config["fontawesome"]["version"]
            category = @category.render(context)
            name = @name.render(context)

            parent = Nokogiri::HTML5.fragment(sprites(category)).at_css("\##{name}")
            parent.name = "svg"
            parent.remove_attribute("id")
            parent.set_attribute("xmlns", "http://www.w3.org/2000/svg")
            parent.set_attribute("class", "font-awesome-icon")
            licensecomment = Nokogiri::XML::Comment.new(parent, <<~TEXT
                ! Font Awesome Free 7.3.1 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License) Copyright 2026 Fonticons, Inc.
                TEXT
            )
            parent.prepend_child(licensecomment)
            
            parent.to_html
        end
    end
end

Liquid::Template.register_tag('fontawesome', FontAwesomeSupport::FontAwesome)
