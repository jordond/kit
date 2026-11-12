# frozen_string_literal: true

require_relative "helper"

# kit passes every optional lane input explicitly, as an empty string when it
# has no value, so a value inherited from the shell or a root .env never
# reaches a lane. Every reader goes through these helpers: empty must read as
# "not given".
class EnvTest < Minitest::Test
  include KitFastfileTest

  def test_an_empty_or_blank_value_is_no_value
    ["", "  ", "\n"].each do |blank|
      with_env("KIT_RELEASE_NOTES" => blank, "KIT_IOS_BUILD" => blank, "KIT_STATUS_TRACKS" => blank) do
        assert_nil kit_env_opt("KIT_RELEASE_NOTES")
        assert_equal "", kit_env_opt("KIT_RELEASE_NOTES", "")
        assert_nil kit_env_opt("KIT_IOS_BUILD")
        assert_empty kit_list("KIT_STATUS_TRACKS")
        refute kit_flag?("KIT_PLAY_DRAFT")
        assert_raises(KitUserError) { kit_env("KIT_RELEASE_NOTES") }
      end
    end
  end

  def test_a_value_is_read_stripped
    with_env("KIT_RELEASE_NOTES" => " Fixes \n", "KIT_STATUS_TRACKS" => "alpha, beta") do
      assert_equal "Fixes", kit_env_opt("KIT_RELEASE_NOTES", "")
      assert_equal %w[alpha beta], kit_list("KIT_STATUS_TRACKS")
    end
  end

  # No lane reads an optional input kit passes around these helpers: an
  # ENV[...] read elsewhere would take "" for a value.
  def test_every_optional_input_is_read_through_a_helper
    fastfile = File.read(File.expand_path("../../fastlane/Fastfile", __dir__))
    direct = fastfile.lines.grep(/ENV(\[|\.fetch\()"KIT_(RELEASE_NOTES|IOS_BUILD|IOS_VERSION|IOS_TEAM_ID|STATUS_TRACKS|ANDROID_CODE)"/)
    assert_empty direct
    %w[KIT_RELEASE_NOTES KIT_IOS_BUILD KIT_IOS_TEAM_ID KIT_ANDROID_CODE].each do |name|
      refute_match(/kit_env\("#{name}"\)/, fastfile, "#{name} is optional: read it with kit_env_opt")
    end
  end
end
