# frozen_string_literal: true

# Runs every test in this directory: `ruby test/fastlane/run.rb`.
# Plain Ruby with its bundled minitest; see helper.rb for why no fastlane bundle is needed.

Dir[File.join(__dir__, "*_test.rb")].sort.each { |file| require file }
