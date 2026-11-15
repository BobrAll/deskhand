import AppKit
import DeskhandAgentKit
import DeskhandCore
import DeskhandLLM
import Foundation

/// `deskhand-agent` — a standalone BYOK agent that drives the desktop.
///
/// Usage:
///   deskhand-agent "open Safari and search for the weather"
///   deskhand-agent --base-url http://localhost:11434/v1 --model qwen2.5-vl "…"
///   deskhand-agent --config ./my.toml "…"
///
/// The window server requires an initialized Cocoa app before any CGEvent or
/// ScreenCaptureKit call; without this the process aborts with `CGS_REQUIRE_INIT`.
_ = NSApplication.shared

struct CLI {
    var task: String?
    var configPath: String?
    var baseURL: String?
    var model: String?
    var apiKey: String?
    var wire: String?
    var maxSteps: Int = 40
    var verbose = true
    var quietAboutDefaults = false
    /// Print the resolved config and exit. `--dry-run` is the same request under
    /// the older name, so both set this.
    var printResolvedConfig = false
    var timings = true
    /// Serve the app instead of running one task from the command line.
    var serve = false
}

func parseArguments() throws -> CLI {
    var cli = CLI()
    var positional: [String] = []
    var iterator = CommandLine.arguments.dropFirst().makeIterator()

    while let argument = iterator.next() {
        switch argument {
        case "--base-url", "-b":
            cli.baseURL = iterator.next()
        case "--model", "-m":
            cli.model = iterator.next()
        case "--api-key", "-k":
            cli.apiKey = iterator.next()
        case "--wire", "-w":
            cli.wire = iterator.next()
        case "--config", "-c":
            cli.configPath = iterator.next()
        case "--max-steps":
            // A zero or negative budget used to reach `for step in 1...maxSteps`
            // and trap, so the standalone binary crashed instead of answering.
            guard let value = iterator.next(), let parsed = Int(value) else {
                throw ToolError.message("--max-steps needs a whole number")
            }
            guard parsed > 0 else {
                throw ToolError.message("--max-steps must be at least 1")
            }
            cli.maxSteps = parsed
        case "--quiet", "-q":
            cli.verbose = false
        case "--quiet-about-defaults":
            cli.quietAboutDefaults = true
        case "--dry-run", "--show-config":
            // Kept as two spellings of one behaviour: `--dry-run` predates
            // `--show-config`, and both mean "resolve the config, print it, do
            // not run a task". No script breaks, and neither flag needs its own
            // branch.
            cli.printResolvedConfig = true
        case "--serve":
            cli.serve = true
        case "--timings":
            // Timings are on by default; the flag exists so a wrapper script can
            // ask for them explicitly after a `--no-timings` in an alias.
            cli.timings = true
        case "--no-timings":
            cli.timings = false
        case "--help", "-h":
            printUsage()
            exit(0)
        default:
            if argument.hasPrefix("-") {
                throw ToolError.message("unknown flag \(argument)")
            }
            positional.append(argument)
        }
    }

    if !positional.isEmpty {
        cli.task = positional.joined(separator: " ")
    }
    return cli
}

func printUsage() {
    print(
        """
        deskhand-agent — drive a macOS app with any vision-capable model (BYOK)

        USAGE
          deskhand-agent --serve           (driven by Deskhand over stdin/stdout)
          deskhand-agent [options] "<task>"

        OPTIONS
          --serve              speak the sidecar protocol instead of running one task
          -b, --base-url URL   API base URL, e.g. https://api.openai.com/v1
          -m, --model NAME     model identifier
          -k, --api-key KEY    API key (defaults to env, then config file)
          -w, --wire WIRE      openai (default) or anthropic
          -c, --config PATH    config file (default ~/.deskhand/config.toml)
              --max-steps N    stop after N model turns (default 40)
              --dry-run        print the resolved config and exit (same as --show-config)
              --show-config    print the resolved config and exit
              --timings        show per-step and per-phase timings (default)
              --no-timings     hide per-step and per-phase timings
          -q, --quiet          only print the final answer
              --quiet-about-defaults
                               do not warn when no base_url is configured

        ENVIRONMENT
          DESKHAND_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
          DESKHAND_BASE_URL, DESKHAND_MODEL, DESKHAND_WIRE

        EXAMPLES
          deskhand-agent "open Notes and add a shopping list"
          deskhand-agent -b http://localhost:11434/v1 -m qwen2.5-vl "open Safari"
          deskhand-agent -w anthropic -m claude-sonnet-4-5 "find my last invoice"
          deskhand-agent --no-timings "open Notes and add a shopping list"

        REQUIRES
          Accessibility and Screen Recording permission for the terminal
          running this binary (System Settings > Privacy & Security).
        """)
}

func buildConfig(_ cli: CLI) throws -> ProviderConfig {
    var config = try ConfigLoader.load(path: cli.configPath)
    if let wire = cli.wire {
        guard let parsed = ProviderConfig.Wire(rawValue: wire) else {
            throw ConfigError.invalidValue("--wire \"\(wire)\" — use \"openai\" or \"anthropic\"")
        }
        config.wire = parsed
    }
    if let base = cli.baseURL {
        // Same rule as the config file: a base URL that does not parse must not
        // be dropped, because the fallback is api.openai.com and the user's key
        // would go there instead of the endpoint they asked for.
        guard let url = URL(string: base), url.scheme != nil, url.host != nil else {
            throw ConfigError.invalidValue("--base-url \"\(base)\" is not a URL")
        }
        config.baseURL = url
    }
    if let model = cli.model {
        config.model = model
    }
    if let key = cli.apiKey {
        config.apiKey = key
    }
    return config
}

let cli: CLI
do {
    cli = try parseArguments()
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(2)
}

// Sidecar mode: the app supplies the provider, the task and the approvals, and
// this process is only the hands. Everything the command line does below —
// config discovery, usage, the final print — belongs to the other mode.
if cli.serve {
    let bridge = Bridge()
    bridge.emit([
        "event": .string("ready"),
        "params": .object([
            "version": .string("1"),
            "tools": .number(Double(ToolSurface.definitions().count)),
        ]),
    ])
    Thread.detachNewThread { bridge.readLoop() }
    // The main thread stays here, pumping the run loop: replies from the window
    // server and from ScreenCaptureKit are delivered to it, and a parked main
    // thread turns every activation into a one-second timeout.
    while true {
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
    }
}

let config: ProviderConfig
do {
    config = try buildConfig(cli)
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(2)
}

if cli.printResolvedConfig {
    print("wire:      \(config.wire.rawValue)")
    print("base_url:  \(config.baseURL.absoluteString)")
    print("endpoint:  \(config.endpointURL.absoluteString)")
    print("model:     \(config.model)")
    print("api_key:   \(config.apiKey == nil ? "unset" : "set")")
    print("max_tokens:\(config.maxTokens)")
    exit(0)
}

// A key alone silently targets api.openai.com, which is the wrong endpoint for
// anyone using OpenRouter, a gateway, or a local server. Say so on stderr rather
// than discovering it as an opaque 401 later.
if !cli.quietAboutDefaults, config.baseURL.absoluteString == ProviderConfig().baseURL.absoluteString {
    FileHandle.standardError.write(
        Data(
            """

            note: no base_url configured, so requests go to \(config.endpointURL.absoluteString).
                  To use another endpoint, pass --base-url / -b, set DESKHAND_BASE_URL, or add
                  base_url to ~/.deskhand/config.toml.

            """.utf8))
}

guard let task = cli.task, !task.isEmpty else {
    printUsage()
    exit(2)
}

let permissions = SystemPermissions.current()
if !permissions.accessibility {
    SystemPermissions.requestAccessibility()
    FileHandle.standardError.write(
        Data(
            """

            Accessibility permission is required. Deskhand has opened the prompt; enable the \
            terminal app you are running this from in System Settings > Privacy & Security > \
            Accessibility, then run the command again.

            """.utf8))
    exit(1)
}
if !permissions.screenRecording {
    SystemPermissions.requestScreenRecording()
    FileHandle.standardError.write(
        Data(
            """
            Screen Recording permission is required for screenshots. Grant it, then rerun.

            """.utf8))
    exit(1)
}

let provider = ProviderFactory.make(config: config)
let executor = ToolExecutor()
let loop = AgentLoop(
    provider: provider,
    executor: executor,
    options: .init(
        maxSteps: cli.maxSteps,
        verbose: cli.verbose,
        timings: cli.timings
    )
)

// The main run loop must keep pumping while the task runs: `NSRunningApplication
// .activate` is asynchronous in the window server and its reply is delivered to
// this loop. Parking the main thread on a semaphore makes every activation wait
// out a one-second timeout (measured: 1016 ms parked, 13 ms pumped).
do {
    let answer = try MainRunLoop.await { try await loop.run(task: task) }
    print(answer)
    if cli.timings {
        FileHandle.standardError.write(Data(("\n" + loop.timingReport() + "\n").utf8))
    }
    executor.shutdown()
} catch {
    FileHandle.standardError.write(Data("error: \(error)\n".utf8))
    exit(1)
}
