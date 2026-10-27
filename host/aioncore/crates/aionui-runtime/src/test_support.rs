pub(crate) fn run_in_env_child<F>(test_name: &str, configure: F) -> bool
where
    F: FnOnce(&mut std::process::Command),
{
    const CHILD_ENV: &str = "AIONUI_RUNTIME_ENV_TEST_CHILD";

    if std::env::var_os(CHILD_ENV).is_some() {
        return true;
    }

    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .arg("--exact")
        .arg(test_name)
        .arg("--nocapture")
        .env(CHILD_ENV, "1");
    configure(&mut command);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "child test failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

/// Windows cannot execute Unix shebang stand-ins. Use CI's setup-node binary
/// with invented npm/npx entrypoints; no package install or network is used.
#[cfg(windows)]
pub(crate) fn write_windows_node_fixture(root: &std::path::Path, include_npm: bool) {
    std::fs::create_dir_all(root).unwrap();
    let node = which::which("node.exe").expect("Windows tests require Node.js from the CI setup-node step");
    std::fs::copy(node, root.join("node.exe")).unwrap();
    if include_npm {
        let bin = root.join("node_modules").join("npm").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for entry in ["npm-cli.js", "npx-cli.js"] {
            std::fs::write(bin.join(entry), "console.log('11.6.2');\n").unwrap();
        }
    }
}
