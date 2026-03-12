#!/usr/bin/env python3
"""
K8s CronJob cleanup script.
Deletes sandbox Pods (and their Services) older than MAX_AGE_SECONDS.
Run every 5 minutes via the cleanup-cronjob.yaml CronJob.
"""

import os
import time
from kubernetes import client as k8s_client, config as k8s_config
import k8s_utils

MAX_AGE_SECONDS = int(os.environ.get("SANDBOX_MAX_AGE_SECONDS", str(2 * 3600)))  # 2h default

try:
    k8s_config.load_incluster_config()
except k8s_config.ConfigException:
    k8s_config.load_kube_config()

core_v1 = k8s_client.CoreV1Api()


def cleanup():
    now = time.time()
    pods = core_v1.list_namespaced_pod(
        namespace=k8s_utils.NAMESPACE,
        label_selector="app=devpilot-sandbox",
    )

    deleted = 0
    for pod in pods.items:
        created_at_str = (pod.metadata.annotations or {}).get("devpilot/created-at")
        if not created_at_str:
            # Fallback: use K8s creation timestamp
            created_ts = pod.metadata.creation_timestamp.timestamp() if pod.metadata.creation_timestamp else now
        else:
            try:
                created_ts = float(created_at_str)
            except ValueError:
                created_ts = now

        age = now - created_ts
        if age > MAX_AGE_SECONDS:
            sandbox_id = pod.metadata.labels.get("sandbox-id", "")
            print(f"[cleanup] Sandbox {sandbox_id} is {age:.0f}s old — deleting...")

            for delete_fn, name in [
                (core_v1.delete_namespaced_pod, f"sandbox-{sandbox_id}"),
                (core_v1.delete_namespaced_service, f"sandbox-{sandbox_id}"),
            ]:
                try:
                    delete_fn(name=name, namespace=k8s_utils.NAMESPACE)
                    print(f"[cleanup]   Deleted {name}")
                except k8s_client.exceptions.ApiException as e:
                    if e.status != 404:
                        print(f"[cleanup]   Error deleting {name}: {e}")

            deleted += 1

    print(f"[cleanup] Done — removed {deleted} sandbox(es)")


if __name__ == "__main__":
    cleanup()
