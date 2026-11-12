# frozen_string_literal: true

require_relative "helper"

# Which iOS build a promotion moves: only one that is in the source tester group.
class PromoteBuildTest < Minitest::Test
  include KitFastfileTest

  # Version 1.4.0 has builds 5 and 7 in the alpha group. Build 9 is newer but
  # internal-only (compiled with KIT_INTERNAL, sent to no group), so the alpha
  # group's builds never include it.
  ALPHA_BUILDS = [Build.new("7"), Build.new("5")].freeze

  def test_picks_the_highest_build_in_the_source_group
    assert_equal "7", kit_ios_select_build(ALPHA_BUILDS, nil, "1.4.0", "alpha").version
  end

  def test_compares_build_numbers_as_numbers
    builds = [Build.new("9"), Build.new("10")]
    assert_equal "10", kit_ios_select_build(builds, nil, "1.4.0", "alpha").version
  end

  def test_takes_the_given_build_when_it_is_in_the_group
    assert_equal "5", kit_ios_select_build(ALPHA_BUILDS, "5", "1.4.0", "alpha").version
  end

  def test_refuses_an_internal_only_build
    error = assert_raises(KitUserError) { kit_ios_select_build(ALPHA_BUILDS, "9", "1.4.0", "alpha") }
    assert_includes error.message, "Build 9 of 1.4.0 is not in the TestFlight group 'alpha'"
    assert_includes error.message, "internal builds are never promoted"
  end

  def test_refuses_when_the_group_has_no_build_of_the_version
    error = assert_raises(KitUserError) { kit_ios_select_build([], nil, "1.4.0", "alpha") }
    assert_includes error.message, "No build of 1.4.0 in the TestFlight group 'alpha'"
  end

  # The whole lookup against a stubbed App Store Connect: the builds are asked
  # for by app, version and source group, so the internal build is never a candidate.
  class FakeApp
    attr_reader :id

    def initialize
      @id = "app-1"
    end

    def get_beta_groups
      [
        KitFastfileTest::Group.new("g-alpha", "alpha", false),
        KitFastfileTest::Group.new("g-beta", "Beta Testers", false),
        # App Store Connect's default for an internal group: every upload lands in it.
        KitFastfileTest::Group.new("g-team", "Team", true)
      ]
    end
  end

  class FakePages
    def initialize(models)
      @models = models
    end

    def all_pages
      [self]
    end

    def to_models
      @models
    end
  end

  def stub_connect_api(builds_by_group)
    filters = []
    api = Module.new
    api.define_singleton_method(:get_builds) do |filter:, **|
      filters << filter
      FakePages.new(builds_by_group.fetch(filter[:betaGroups], []))
    end
    Object.const_set(:Spaceship, Module.new) unless Object.const_defined?(:Spaceship)
    Spaceship.send(:remove_const, :ConnectAPI) if Spaceship.const_defined?(:ConnectAPI, false)
    Spaceship.const_set(:ConnectAPI, api)
    filters
  end

  def lookup(app, env)
    define_singleton_method(:kit_asc_login) { nil }
    define_singleton_method(:kit_ios_app) { app }
    with_env({ "KIT_IOS_VERSION" => "1.4.0", "KIT_IOS_BUILD" => nil }.merge(env)) { kit_ios_promote_build }
  end

  def test_lookup_asks_for_the_source_groups_builds_only
    filters = stub_connect_api("g-alpha" => ALPHA_BUILDS, "g-beta" => [Build.new("3")])
    _app, build = lookup(FakeApp.new, "KIT_TESTFLIGHT_FROM_GROUP" => "alpha")
    assert_equal "7", build.version
    assert_equal [{ app: "app-1", betaGroups: "g-alpha", "preReleaseVersion.version" => "1.4.0", expired: "false" }],
                 filters

    _app, build = lookup(FakeApp.new, "KIT_TESTFLIGHT_FROM_GROUP" => "Beta Testers")
    assert_equal "3", build.version
  end

  def test_lookup_refuses_the_internal_build_even_when_named
    stub_connect_api("g-alpha" => ALPHA_BUILDS)
    error = assert_raises(KitUserError) do
      lookup(FakeApp.new, "KIT_TESTFLIGHT_FROM_GROUP" => "alpha", "KIT_IOS_BUILD" => "9")
    end
    assert_includes error.message, "is not in the TestFlight group 'alpha'"
  end

  # In an all-builds group the internal build 9 is "in" the group and has the
  # highest number: it would be the default pick. The group is refused instead.
  def test_lookup_refuses_a_source_group_that_receives_every_build
    filters = stub_connect_api("g-team" => [Build.new("9"), *ALPHA_BUILDS])
    [{}, { "KIT_IOS_BUILD" => "7" }].each do |env|
      error = assert_raises(KitUserError) do
        lookup(FakeApp.new, { "KIT_TESTFLIGHT_FROM_GROUP" => "Team" }.merge(env))
      end
      assert_includes error.message, "The TestFlight group 'Team' receives every build automatically"
      assert_includes error.message, "source group that receives builds explicitly"
    end
    assert_empty filters, "the builds are not even asked for"
  end

  def test_explicit_groups_pass_the_check
    group = Group.new("g-alpha", "alpha", false)
    assert_same group, kit_ios_require_explicit_group(group)
    unset = Group.new("g", "no attribute in the answer", nil)
    assert_same unset, kit_ios_require_explicit_group(unset)
  end

  def test_lookup_fails_on_an_unknown_source_group
    stub_connect_api({})
    error = assert_raises(KitUserError) { lookup(FakeApp.new, "KIT_TESTFLIGHT_FROM_GROUP" => "gamma") }
    assert_includes error.message, "No TestFlight group 'gamma'"
  end
end
