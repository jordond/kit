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
end
