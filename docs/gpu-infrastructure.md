# Shared GPU infrastructure

## Implemented execution path

The `src/gpu/` subsystem contains an actual worker execution path, not just allocation records:

1. `NvidiaWorkerAgent` queries `nvidia-smi` for UUID, index, model, total/used VRAM, utilization, temperature, and MIG mode.
2. `GpuScheduler` persists inventory in SQLite migration 5 and selects a GPU using available memory and compute quotas.
3. Multiple computers can receive allocations on the same physical GPU. Dedicated allocation is an explicit exception, not the default.
4. The worker attaches the selected GPU to the Incus computer and executes either `nvidia-smi` or a fixed CUDA Runtime workload using `cudaMalloc` and `cudaMemset`.
5. Metrics are sampled through `nvidia-smi` and stored with the allocation.
6. Device ownership is released after execution. Final status, failure, and release timestamps are persisted.
7. Scheduler recovery marks previously running outcomes uncertain and releases recorded device attachments.
8. The authenticated control plane exposes `GET /gpus`, `GET/POST /gpu/allocations`, and `GET /gpu/metrics`.

The workload API accepts no arbitrary shell command. The CUDA workload allocates and writes real GPU memory when run on compatible hardware.

## Guest CUDA runtime

Two separate things have to be true inside a guest before a CUDA workload runs, and they come from different places:

- **Driver libraries** are mounted by the host through Incus, via `nvidia.runtime=true`. They are not installed in the guest.
- **The CUDA Runtime** (`libcudart`) is a userspace library that must exist *inside* the guest. `GuestProvisioner.installCudaRuntime()` installs it together with `python3` (the fixed workload is a Python program using `ctypes`).

The library name matters and was wrong: Ubuntu 24.04's only CUDA Runtime package is `libcudart12` (multiverse), which ships `libcudart.so.12` and **nothing named `libcudart.so.1`**. The workload and the provisioner both read `CUDA_RUNTIME_LIBRARY` from `src/gpu/types.ts`, so the soname cannot drift again.

`nvidia.runtime` is documented as **not** a live-updatable option, so setting it on a running container attaches a device without the userspace libraries — the exact driver/library mismatch the option exists to prevent. The attachment therefore runs in one order: set `nvidia.runtime`, add the GPU device (and the MPS pipe mount), and then restart **only if the option was not already set**. A single start applies both the libraries and the device; the option is left set afterwards so later allocations read it back and skip the restart, and the restart happens at most once per computer. It does interrupt an open desktop session once; the guest's own `syntrum-*` units bring the desktop back when the container starts.

Before the workload starts, the agent proves inside the guest that `libcudart` loads and a context can be created. A guest without the runtime is refused with a message naming `installCudaRuntime`, rather than failing mid-run with an opaque CUDA error.

## Scheduling semantics and limitations

### Conservative memory accounting

Available capacity is calculated as total VRAM minus currently used VRAM minus memory reserved by active SYNTRUM allocations. This can double-count memory already used by an active SYNTRUM workload, so it is intentionally conservative rather than maximally efficient. It prevents overcommit at the cost of underutilization.

### Time-slicing

Time-slicing permits concurrent device access but does not provide hard compute or memory isolation. The scheduler's compute percentage is cooperative policy, not an enforcement guarantee. One workload can still starve another or allocate beyond its intended share if it executes arbitrary code.

### NVIDIA MPS

MPS mode starts `nvidia-cuda-mps-control` and sets `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE` for the guest workload. This provides a real MPS compute-thread quota on compatible CUDA systems. MPS does not provide MIG-style hardware partitioning, complete fault isolation, or generic Vulkan/OpenGL virtualization.

### MIG

Discovery records whether `nvidia-smi` reports MIG as enabled or disabled. Dynamic MIG creation/allocation is not implemented and returns `MIG_REQUIRES_PREPROVISIONED_PARTITION`. Supported hardware and pre-created partitions are required before MIG can be used.

### Incus boundary

GPU passthrough makes a device visible to the container; it does not create VRAM isolation. The current architecture uses worker-side execution, device attachment, MPS quotas where supported, and conservative scheduling. Hard isolation requires MIG, a stronger sandbox/microVM boundary, or a different workload architecture.

## Live acceptance requirements

No NVIDIA worker is configured, so real GPU utilization, memory behavior, concurrent guest execution, capacity rejection on hardware, release, restart recovery, and the guest CUDA runtime installation are `IMPLEMENTED BUT NOT VERIFIED`.

`npm run test:live-gpu` is the gate. It installs the guest CUDA runtime, runs one allocation through the real scheduler, records `nvidia-smi` output from inside the guest, and deletes everything it creates. It refuses early with `BLOCKED_NO_NVIDIA_HARDWARE` when the worker has no working driver, so it cannot idly burn rental time.

Required:

- Remote Ubuntu 24.04 x86-64 worker with SSH/Incus configured as in `docs/cloud-infrastructure.md`.
- NVIDIA GPU supported by `nvidia-smi`, its driver, and CUDA Runtime (`libcudart12`, from multiverse).
- Incus GPU-passthrough permissions and matching host/guest driver compatibility.
- Python 3 in the guest for the fixed CUDA workload (installed with the runtime).
- MPS-capable hardware/software for MPS tests; supported A100/H100-class hardware and pre-created partitions for MIG tests.

Indicative infrastructure cost, not a provider quote: a small T4/L4-class cloud worker is commonly $150–$400/month on demand. MIG-capable instances cost substantially more. Use a short-lived acceptance worker to control cost.

## Unit verification

`npm test` reports **54 discovered, 53 passed, 0 failed, 1 skipped**. The three GPU unit tests verify:

- Two computers receiving concurrent allocations on one physical GPU.
- Conservative capacity rejection and release timestamps.
- Recovery marking and device release.
- NVIDIA output parsing and Incus/CUDA command construction.

These tests do not use mocked statistics as live GPU evidence. No live GPU acceptance has run yet.

## Required live acceptance sequence

1. Create two real Linux computers and open their desktops through noVNC.
2. Install and run the SYNTRUM MCP runtime in both guests.
3. Start the fixed CUDA workload concurrently in both computers on one physical GPU.
4. Record actual `nvidia-smi` utilization and memory before, during, and after execution.
5. Request more than remaining capacity and verify rejection.
6. Verify device release after both workloads terminate.
7. Restart the scheduler and worker independently and record recovery behavior and uncertain outcomes.
8. Run separate MPS and MIG tests only on hardware that supports them.
