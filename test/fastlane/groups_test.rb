# frozen_string_literal: true

require_relative "helper"

# TestFlight group names must match the app's groups: pilot skips a miss silently.
class GroupsTest < Minitest::Test
  include KitFastfileTest

  GROUPS = [Group.new("g-alpha", "alpha"), Group.new("g-beta", "Beta Testers")].freeze

  def test_resolves_names_and_ids_in_order
    assert_equal %w[g-beta g-alpha], kit_ios_resolve_groups(GROUPS, ["Beta Testers", "g-alpha"]).map(&:id)
  end

  def test_fails_on_a_name_the_app_does_not_have
    error = assert_raises(KitUserError) { kit_ios_resolve_groups(GROUPS, ["Beta Testers", "beta"]) }
    assert_equal "No TestFlight group 'beta' for this app (groups: alpha, Beta Testers)", error.message
  end

  def test_names_are_case_sensitive_like_pilot
    assert_raises(KitUserError) { kit_ios_resolve_groups(GROUPS, ["beta testers"]) }
  end
end

# "No phased release" is one specific answer; every other failure stays a failure.
class PhasedReleaseTest < Minitest::Test
  class Version
    def initialize(&fetch)
      @fetch = fetch
    end

    def fetch_app_store_version_phased_release
      @fetch.call
    end
  end

  class AuthError < StandardError; end

  def test_returns_the_phased_release
    assert_equal :phased, kit_ios_phased_release(Version.new { :phased })
  end

  def test_no_data_means_no_phased_release
    assert_nil kit_ios_phased_release(Version.new { raise "No data" })
  end

  def test_other_errors_are_not_swallowed
    assert_raises(AuthError) { kit_ios_phased_release(Version.new { raise AuthError, "401" }) }
    error = assert_raises(RuntimeError) { kit_ios_phased_release(Version.new { raise "connection reset" }) }
    assert_equal "connection reset", error.message
  end
end
