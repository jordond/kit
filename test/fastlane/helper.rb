# frozen_string_literal: true

# Loads kit's shared Fastfile outside fastlane, so its kit_* helper methods can
# run against stubbed store objects. The fastlane DSL is stubbed to do nothing:
# `platform` blocks are not evaluated, so no lane is defined and no action runs.
# Nothing here loads the fastlane gem or talks to a store.
#
#   ruby test/fastlane/run.rb

require "minitest/autorun"

class KitUserError < StandardError; end

# fastlane's UI: user_error! raises (as in fastlane), the rest is silent.
module UI
  def self.user_error!(message)
    raise KitUserError, message
  end

  def self.important(*); end
  def self.message(*); end
  def self.success(*); end
end

def platform(*); end
def lane(*); end
def desc(*); end

load File.expand_path("../../fastlane/Fastfile", __dir__)

module KitFastfileTest
  Group = Struct.new(:id, :name)
  Build = Struct.new(:version)
  Release = Struct.new(:status, :version_codes, :user_fraction)
  Track = Struct.new(:track, :releases)

  # Run the block with ENV entries set, then restore them.
  def with_env(vars)
    saved = vars.keys.to_h { |k| [k, ENV.fetch(k, nil)] }
    vars.each { |k, v| ENV[k] = v }
    yield
  ensure
    saved.each { |k, v| ENV[k] = v }
  end

  # What kit_emit wrote to stdout, as { "KEY" => "value" }.
  def emitted
    out, = capture_io { yield }
    out.lines.to_h { |l| l.strip.delete_prefix("KIT_").split("=", 2) }
  end
end
