require 'jekyll'
require 'digest'

module Sha256Filter
  def gravatar_hash(input)
    Digest::SHA256.hexdigest(input.strip.downcase)
  end
end

Liquid::Template.register_filter(Sha256Filter)
