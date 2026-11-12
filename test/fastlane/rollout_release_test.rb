# frozen_string_literal: true

require_relative "helper"

# Which Play production release a rollout change touches, and what it becomes.
class RolloutReleaseTest < Minitest::Test
  include KitFastfileTest

  def completed
    Release.new("completed", ["38"], nil)
  end

  def in_progress(code = "40", fraction = 0.1)
    Release.new("inProgress", [code], fraction)
  end

  def halted(code = "40", fraction = 0.1)
    Release.new("halted", [code], fraction)
  end

  def draft(code = "41")
    Release.new("draft", [code], nil)
  end

  def test_picks_the_rollout_in_progress_not_the_draft
    releases = [completed, draft, in_progress]
    %w[percent halt complete].each do |action|
      assert_equal ["40"], kit_play_rollout_release(releases, action, nil).version_codes
    end
  end

  def test_never_publishes_a_draft_when_nothing_is_rolling_out
    %w[percent complete halt].each do |action|
      error = assert_raises(KitUserError) { kit_play_rollout_release([completed, draft], action, nil) }
      assert_includes error.message, "No inProgress release on the production track"
    end
    assert_raises(KitUserError) { kit_play_rollout_release(nil, "percent", nil) }
  end

  def test_resume_picks_the_halted_release
    assert_equal "halted", kit_play_rollout_release([completed, halted], "resume", nil).status
    error = assert_raises(KitUserError) { kit_play_rollout_release([completed, in_progress], "resume", nil) }
    assert_includes error.message, "there is no halted rollout to resume"
  end

  def test_percent_on_a_halted_rollout_says_to_resume_first
    error = assert_raises(KitUserError) { kit_play_rollout_release([halted], "percent", nil) }
    assert_includes error.message, "resume a halted one first"
  end

  def test_two_candidates_need_a_version_code
    releases = [in_progress("40"), in_progress("42", 0.5)]
    error = assert_raises(KitUserError) { kit_play_rollout_release(releases, "percent", nil) }
    assert_includes error.message, "More than one inProgress release"
    assert_includes error.message, "40, 42"
    assert_includes error.message, "--build <version code>"
    assert_equal ["42"], kit_play_rollout_release(releases, "percent", "42").version_codes
    assert_equal ["40"], kit_play_rollout_release(releases, "halt", 40).version_codes
  end

  def test_a_version_code_that_is_not_rolling_out_fails
    error = assert_raises(KitUserError) { kit_play_rollout_release([in_progress, draft], "percent", "41") }
    assert_includes error.message, "No inProgress release on the production track with version code 41"
  end

  def test_percent_sets_the_fraction
    release = kit_play_apply_rollout(in_progress, "percent", "0.25")
    assert_equal ["inProgress", 0.25], [release.status, release.user_fraction]
  end

  def test_full_percent_and_complete_finish_the_rollout
    [%w[percent 1], ["complete", nil]].each do |action, fraction|
      release = kit_play_apply_rollout(in_progress, action, fraction)
      assert_equal "completed", release.status
      assert_nil release.user_fraction
    end
  end

  def test_halt_and_resume_keep_the_fraction
    release = kit_play_apply_rollout(in_progress("40", 0.2), "halt", nil)
    assert_equal ["halted", 0.2], [release.status, release.user_fraction]
    release = kit_play_apply_rollout(halted("40", 0.2), "resume", nil)
    assert_equal ["inProgress", 0.2], [release.status, release.user_fraction]
  end

  # Rolled out to everyone, then halted in the Play Console: no fraction left.
  def test_resume_of_a_release_halted_at_full_rollout_fails_and_does_not_complete_it
    release = halted("40", nil)
    error = assert_raises(KitUserError) { kit_play_apply_rollout(release, "resume", nil) }
    assert_includes error.message, "version code 40"
    assert_includes error.message, "halted at 100%"
    assert_includes error.message, "kit release rollout android --complete"
    assert_equal ["halted", nil], [release.status, release.user_fraction]
  end

  def test_rejects_a_fraction_out_of_range_and_an_unknown_action
    ["0", "1.5", "-0.1", "abc"].each do |fraction|
      assert_raises(KitUserError) { kit_play_apply_rollout(in_progress, "percent", fraction) }
    end
    assert_raises(KitUserError) { kit_play_apply_rollout(in_progress, "pause", nil) }
  end

  # The whole edit against a stubbed Supply::Client: one update naming only the
  # chosen release, then a commit; a failure aborts the edit and commits nothing.
  class FakeClient
    attr_reader :calls, :updated

    def initialize(track)
      @track = track
      @calls = []
    end

    def begin_edit(package_name:)
      @calls << [:begin_edit, package_name]
    end

    def tracks(name)
      @calls << [:tracks, name]
      @track ? [@track] : []
    end

    def update_track(name, track)
      @calls << [:update_track, name]
      @updated = track.releases.map { |r| [r.status, r.version_codes, r.user_fraction] }
    end

    def commit_current_edit!
      @calls << [:commit]
    end

    def abort_current_edit
      @calls << [:abort]
    end
  end

  def stub_supply(client)
    supply = Module.new
    supply.singleton_class.send(:attr_accessor, :config)
    supply.const_set(:Options, Module.new { def self.available_options = [] })
    supply.const_set(:Client, Module.new)
    supply::Client.define_singleton_method(:make_from_config) { client }
    core = Module.new
    core.const_set(:Configuration, Module.new { def self.create(_options, values) = values })
    replace_const(:Supply, supply)
    replace_const(:FastlaneCore, core)
  end

  def replace_const(name, value)
    Object.send(:remove_const, name) if Object.const_defined?(name)
    Object.const_set(name, value)
  end

  def update(client, action, fraction = nil, code = nil)
    stub_supply(client)
    define_singleton_method(:require) { |_name| true } # "supply" is the stub above
    define_singleton_method(:kit_play_json_key) { "/tmp/play.json" }
    with_env("KIT_ANDROID_PACKAGE" => "app.example") { kit_play_update_rollout(action, fraction, code) }
  end

  def test_update_changes_only_the_rollout_in_progress_and_commits
    client = FakeClient.new(Track.new("production", [completed, draft, in_progress]))
    release = update(client, "percent", "0.5")
    assert_equal ["inProgress", 0.5], [release.status, release.user_fraction]
    assert_equal [["inProgress", ["40"], 0.5]], client.updated
    assert_equal [[:begin_edit, "app.example"], [:tracks, "production"], [:update_track, "production"], [:commit]],
                 client.calls
  end

  def test_update_aborts_the_edit_when_there_is_only_a_draft
    client = FakeClient.new(Track.new("production", [completed, draft]))
    assert_raises(KitUserError) { update(client, "complete") }
    assert_nil client.updated
    assert_equal [:abort], client.calls.last
    refute_includes client.calls, [:commit]
  end

  def test_update_commits_nothing_for_a_release_halted_at_full_rollout
    client = FakeClient.new(Track.new("production", [completed, halted("40", nil)]))
    assert_raises(KitUserError) { update(client, "resume") }
    assert_nil client.updated
    assert_equal [:abort], client.calls.last
    refute_includes client.calls, [:commit]
  end

  def test_update_fails_without_a_production_track
    client = FakeClient.new(nil)
    error = assert_raises(KitUserError) { update(client, "halt") }
    assert_equal "The app has no production track", error.message
    refute_includes client.calls, [:commit]
  end
end
