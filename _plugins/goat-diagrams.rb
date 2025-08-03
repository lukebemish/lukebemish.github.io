require 'jekyll'

module GoatDiagrams
    class GoatBlock < Liquid::Block
        def render(context)
            text = super
            outText = "<div class=\"goat-svg\">"+render_with_command('goat -sls currentColor -sds currentColor', text.gsub(/^#{$/}/, "").gsub(/#{$/}$/, ""))+"</div>"
            outText.gsub(/svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' version='1\.1' height='(\d+)' width='(\d+)'/) { |m| "svg xmlns='http://www.w3.org/2000/svg' version='1.1' width='100%' viewBox='0 0 #{$2} #{$1}' preserveAspectRatio='xMidYMid'" }
        end

        def render_with_command(command, contents)
            begin
            stdout, stderr, status = Open3.capture3(command, stdin_data: contents)
            rescue Errno::ENOENT
            raise Errors::CommandNotFoundError, command.split(' ')[0]
            end

            unless status.success?
            raise Errors::RenderingFailedError, <<~MSG
                #{command}: #{stderr.empty? ? stdout : stderr}
            MSG
            end

            stdout
        end
    end
end

Liquid::Template.register_tag('goat', GoatDiagrams::GoatBlock)
