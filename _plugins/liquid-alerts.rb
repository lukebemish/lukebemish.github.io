require 'jekyll'
require 'octicons'

ADMONITION_ICONS = {
  'important' => 'report',
  'note' => 'info',
  'tip' => 'light-bulb',
  'warning' => 'alert',
  'caution' => 'stop'
}.freeze

module LiquidAlerts
    class AlertBlock < Liquid::Block
        def initialize(tag_name, text, tokens)
            super
            @type = text.downcase.strip()
        end

        def render(context)
            site = context.registers[:site]
            markdown= site.find_converter_instance(::Jekyll::Converters::Markdown)
            text = super
            "<div class='markdown-alert markdown-alert-#{@type}'>" \
                "<p class='markdown-alert-title'>#{Octicons::Octicon.new(ADMONITION_ICONS[@type]).to_svg} #{@type.capitalize}</p>" \
                "#{markdown.convert(text.gsub(/^#{$/}/, "").gsub(/#{$/}$/, ""))}" \
            "</div>"
        end
    end
end

Liquid::Template.register_tag('alert', LiquidAlerts::AlertBlock)
