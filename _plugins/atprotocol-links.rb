require 'xxhash'

module ATProtocolSupport
    class Generator < Jekyll::Generator
        safe true
        priority :lowest

        ALPHABET = '234567abcdefghijklmnopqrstuvwxyz'.chars.freeze

        def generate(site)
            tids = []
            site.posts.docs.each do |post|
                page_date = post.data['date'].utc

                usec_since_epoch = page_date.to_i * 1_000_000 + page_date.usec

                post_id = post.url.to_s

                tid_int = (
                    usec_since_epoch << 10
                ) | (
                    XXhash.xxh32(post_id.encode('UTF-8'), 0) & 0x3FF
                )
                tid_int = 0x1FFFFFFFFFFFFF & tid_int
                chars = []
                for i in 1..13
                    chars.unshift(ALPHABET[tid_int & 0x1F])
                    tid_int >>= 5
                end

                tids.push(chars.join)

                post.data["atproto-rkey"] = chars.join
            end

            if tids.uniq.length != tids.length
                raise "Not all post TIDs for AT Protocol were unique! #{tids}"
            end
        end
    end
end