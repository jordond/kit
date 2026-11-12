# frozen_string_literal: true

require_relative "helper"
require "fileutils"
require "tmpdir"

# The store-listing helpers: what is never pushed, what a pull removes, and
# which downloaded Play images count.
class MetadataTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir("kit-metadata-test")
  end

  def teardown
    FileUtils.rm_rf(@dir)
  end

  def write(path, content = "x")
    file = File.join(@dir, path)
    FileUtils.mkdir_p(File.dirname(file))
    File.write(file, content)
    file
  end

  def listing(*extra)
    write("listing/en-US/description.txt", "Hello")
    write("listing/copyright.txt", "2026")
    write("listing/android/en-US/title.txt", "Play title")
    write("listing/.DS_Store")
    extra.each { |path| write("listing/#{path}", "secret") }
    File.join(@dir, "listing")
  end

  def pushed(source)
    into = kit_metadata_for_push(source, File.join(@dir, "pushed"))
    Dir.glob("**/*", base: into).select { |p| File.file?(File.join(into, p)) }.sort
  end

  def test_push_copy_never_holds_review_information
    source = listing("review_information/demo_password.txt", "review_information/phone_number.txt")
    assert_equal %w[copyright.txt en-US/description.txt], pushed(source)
    # the repo's copy is left as it was
    assert File.exist?(File.join(source, "review_information/demo_password.txt"))
  end

  def test_push_copy_excludes_review_information_in_any_case
    source = listing("Review_Information/demo_password.txt")
    assert_equal %w[copyright.txt en-US/description.txt], pushed(source)
  end

  def test_push_copy_skips_the_play_listing_and_dotfiles
    refute(pushed(listing).any? { |p| p.start_with?("android", ".") })
  end

  def test_pull_strips_review_information
    source = listing("review_information/demo_user.txt")
    assert kit_strip_review_information(source)
    refute File.exist?(File.join(source, "review_information"))
    assert File.exist?(File.join(source, "en-US/description.txt"))
  end

  def test_pull_strips_review_information_in_any_case
    source = listing("REVIEW_INFORMATION/demo_user.txt")
    assert kit_strip_review_information(source)
    assert_empty(Dir.children(source).select { |e| e.casecmp?("review_information") })
  end

  def test_strip_reports_when_there_was_nothing_to_remove
    refute kit_strip_review_information(listing)
    refute kit_strip_review_information(File.join(@dir, "missing"))
  end

  # get_edit_app_store_version answers with the version deliver would edit, or nil.
  class App
    attr_reader :asked

    def initialize(version)
      @version = version
    end

    def get_edit_app_store_version(platform:)
      @asked = platform
      @version
    end
  end

  def test_editable_version_is_returned
    app = App.new(:version)
    assert_equal :version, kit_require_editable_version(app, "IOS", "app.example")
    assert_equal "IOS", app.asked
  end

  def test_no_editable_version_fails_at_once
    error = assert_raises(KitUserError) { kit_require_editable_version(App.new(nil), "IOS", "app.example") }
    assert_includes error.message, "app.example has no editable App Store version"
  end

  PNG = "\x89PNG image bytes"

  def images(files)
    files.each { |path, content| write("play/en-US/images/#{path}", content) }
    File.join(@dir, "play")
  end

  def missing(root, expected, since = Time.now - 60)
    kit_play_missing_images(root, "en-US", expected, since)
  end

  def test_every_image_downloaded
    root = images("icon.png" => PNG, "phoneScreenshots/1_en-US.png" => PNG, "phoneScreenshots/2_en-US.jpeg" => PNG,
                  "featureGraphic.JPG" => PNG)
    assert_empty missing(root, "icon" => 1, "phoneScreenshots" => 2, "featureGraphic" => 1, "tvBanner" => 0)
  end

  def test_a_missing_file_is_reported_with_counts
    root = images("phoneScreenshots/1_en-US.png" => PNG)
    assert_equal ["en-US/icon (0 of 1)", "en-US/phoneScreenshots (1 of 2)"],
                 missing(root, "icon" => 1, "phoneScreenshots" => 2)
  end

  def test_an_error_body_is_not_an_image
    # supply writes the response body whatever the status: `<type>.` when it
    # cannot tell the image type, an empty file, or a non-image extension.
    root = images("icon." => "<html>403 Forbidden</html>", "featureGraphic.png" => "",
                  "phoneScreenshots/1_en-US.html" => "<html>502</html>", "phoneScreenshots/2_en-US.png" => PNG)
    assert_equal ["en-US/icon (0 of 1)", "en-US/featureGraphic (0 of 1)", "en-US/phoneScreenshots (1 of 2)"],
                 missing(root, "icon" => 1, "featureGraphic" => 1, "phoneScreenshots" => 2)
  end

  def test_a_stale_file_from_an_earlier_pull_does_not_count
    root = images("icon.png" => PNG)
    assert_equal ["en-US/icon (0 of 1)"], missing(root, { "icon" => 1 }, Time.now + 60)
  end

  include KitFastfileTest

  # What `kit release metadata push` sets: KIT_METADATA_SCREENSHOTS=1 for --screenshots,
  # KIT_METADATA_TEXT=0 on top of it for --only-screenshots.
  def push_env(screenshots: nil, text: nil, &block)
    with_env("KIT_METADATA_SCREENSHOTS" => screenshots, "KIT_METADATA_TEXT" => text, &block)
  end

  SUPPLY_NEVER = { skip_upload_apk: true, skip_upload_aab: true, skip_upload_changelogs: true }.freeze

  def test_a_push_sends_text_only_by_default
    push_env do
      assert_equal({ skip_metadata: false, skip_screenshots: true, overwrite_screenshots: false },
                   kit_deliver_listing_options)
      assert_equal SUPPLY_NEVER.merge(skip_upload_metadata: false, skip_upload_images: true,
                                      skip_upload_screenshots: true),
                   kit_supply_listing_options
    end
  end

  def test_screenshots_go_with_the_text
    push_env(screenshots: "1") do
      assert_equal({ skip_metadata: false, skip_screenshots: false, overwrite_screenshots: true },
                   kit_deliver_listing_options)
      assert_equal SUPPLY_NEVER.merge(skip_upload_metadata: false, skip_upload_images: false,
                                      skip_upload_screenshots: false),
                   kit_supply_listing_options
    end
  end

  def test_text_off_maps_to_skip_metadata_on_ios
    push_env(screenshots: "1", text: "0") do
      assert_equal({ skip_metadata: true, skip_screenshots: false, overwrite_screenshots: true },
                   kit_deliver_listing_options)
    end
  end

  def test_text_off_maps_to_skip_upload_metadata_on_android_and_still_no_binary_or_changelog
    push_env(screenshots: "1", text: "0") do
      assert_equal SUPPLY_NEVER.merge(skip_upload_metadata: true, skip_upload_images: false,
                                      skip_upload_screenshots: false),
                   kit_supply_listing_options
    end
  end

  def test_text_set_to_anything_but_off_keeps_the_text
    ["1", "true", "on", "ON", "enabled", "2", " "].each do |value|
      push_env(text: value) { refute kit_deliver_listing_options[:skip_metadata], "KIT_METADATA_TEXT=#{value.inspect}" }
    end
  end

  def test_only_0_false_and_no_turn_the_text_off_in_any_case
    ["0", "false", "no", "FALSE", "No", " 0 "].each do |value|
      push_env(screenshots: "1", text: value) do
        assert kit_deliver_listing_options[:skip_metadata], "KIT_METADATA_TEXT=#{value.inspect}"
        assert kit_supply_listing_options[:skip_upload_metadata], "KIT_METADATA_TEXT=#{value.inspect}"
      end
    end
  end

  # The other flags keep kit_flag?'s reading: anything but 1/true/yes is off.
  def test_screenshots_need_an_explicit_on
    %w[0 on false].each do |value|
      push_env(screenshots: value) { assert kit_deliver_listing_options[:skip_screenshots] }
    end
  end

  def test_text_off_without_screenshots_is_nothing_to_upload
    push_env(text: "0") do
      error = assert_raises(KitUserError) { kit_listing_parts }
      assert_includes error.message, "KIT_METADATA_TEXT=0 needs KIT_METADATA_SCREENSHOTS=1"
    end
  end

  def test_the_success_line_names_what_went_up
    assert_equal "listing", kit_listing_summary({ text: true, images: false }, "screenshots")
    assert_equal "listing and screenshots", kit_listing_summary({ text: true, images: true }, "screenshots")
    assert_equal "screenshots", kit_listing_summary({ text: false, images: true }, "screenshots")
  end
end
