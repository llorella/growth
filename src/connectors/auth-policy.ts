export function providerCapabilityPolicy() {
  return {
    secret_safe: true,
    do_not_read_env_files_directly: true,
    do_not_probe_provider_apis_directly: true,
    use_growth_commands: [
      'growth connector auth check <source> --json',
      'growth connector auth setup <source> --json',
      'growth env set --key <KEY> --stdin',
    ],
  };
}
