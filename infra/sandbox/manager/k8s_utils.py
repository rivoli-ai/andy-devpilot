"""
K8s manifest builders for sandbox Pods and Services.
Used by manager.py when BACKEND=k8s.
"""

import os
from kubernetes import client as k8s_client

NAMESPACE          = os.environ.get("K8S_NAMESPACE", "sandboxes")
SANDBOX_IMAGE      = os.environ.get("SANDBOX_IMAGE", "devpilot-desktop:latest")
IMAGE_PULL_SECRET  = os.environ.get("IMAGE_PULL_SECRET", "")  # empty = no pull secret (local image)
CPU_REQUEST        = os.environ.get("SANDBOX_CPU_REQUEST", "250m")
CPU_LIMIT          = os.environ.get("SANDBOX_CPU_LIMIT", "2000m")
MEM_REQUEST        = os.environ.get("SANDBOX_MEM_REQUEST", "512Mi")
MEM_LIMIT          = os.environ.get("SANDBOX_MEM_LIMIT", "2Gi")

NOVNC_NODEPORT_START  = int(os.environ.get("NOVNC_NODEPORT_START", "30100"))
BRIDGE_NODEPORT_START = int(os.environ.get("BRIDGE_NODEPORT_START", "31100"))
MAX_SANDBOXES         = int(os.environ.get("MAX_SANDBOXES", "100"))


def get_used_nodeports(core_v1: k8s_client.CoreV1Api) -> set:
    """Return the set of NodePorts currently in use in the sandboxes namespace."""
    used = set()
    try:
        services = core_v1.list_namespaced_service(
            namespace=NAMESPACE, label_selector="app=devpilot-sandbox"
        )
        for svc in services.items:
            for port in svc.spec.ports:
                if port.node_port:
                    used.add(port.node_port)
    except Exception:
        pass
    return used


def allocate_nodeport_pair(core_v1: k8s_client.CoreV1Api):
    """Return (vnc_nodeport, bridge_nodeport) or (None, None) if exhausted."""
    used = get_used_nodeports(core_v1)
    for i in range(MAX_SANDBOXES):
        vnc    = NOVNC_NODEPORT_START + i
        bridge = BRIDGE_NODEPORT_START + i
        if vnc not in used and bridge not in used:
            return vnc, bridge
    return None, None


def build_pod_manifest(sandbox_id: str, environment: dict) -> k8s_client.V1Pod:
    env_vars = [
        k8s_client.V1EnvVar(name=k, value=str(v))
        for k, v in environment.items()
    ]

    container = k8s_client.V1Container(
        name="desktop",
        image=SANDBOX_IMAGE,
        image_pull_policy="IfNotPresent" if not IMAGE_PULL_SECRET else "Always",
        ports=[
            k8s_client.V1ContainerPort(container_port=6080, name="novnc"),
            k8s_client.V1ContainerPort(container_port=8091, name="bridge"),
        ],
        env=env_vars,
        resources=k8s_client.V1ResourceRequirements(
            requests={"memory": MEM_REQUEST, "cpu": CPU_REQUEST},
            limits={"memory": MEM_LIMIT,    "cpu": CPU_LIMIT},
        ),
        volume_mounts=[
            k8s_client.V1VolumeMount(mount_path="/dev/shm", name="dshm")
        ],
    )

    volumes = [
        k8s_client.V1Volume(
            name="dshm",
            empty_dir=k8s_client.V1EmptyDirVolumeSource(medium="Memory", size_limit="512Mi"),
        )
    ]

    image_pull_secrets = (
        [k8s_client.V1LocalObjectReference(name=IMAGE_PULL_SECRET)]
        if IMAGE_PULL_SECRET else []
    )

    return k8s_client.V1Pod(
        api_version="v1",
        kind="Pod",
        metadata=k8s_client.V1ObjectMeta(
            name=f"sandbox-{sandbox_id}",
            namespace=NAMESPACE,
            labels={
                "app":        "devpilot-sandbox",
                "sandbox-id": sandbox_id,
            },
            annotations={
                "devpilot/created-at": str(__import__("time").time()),
            },
        ),
        spec=k8s_client.V1PodSpec(
            restart_policy="Never",
            service_account_name=None,
            image_pull_secrets=image_pull_secrets or None,
            containers=[container],
            volumes=volumes,
        ),
    )


def build_service_manifest(
    sandbox_id: str, vnc_nodeport: int, bridge_nodeport: int
) -> k8s_client.V1Service:
    return k8s_client.V1Service(
        api_version="v1",
        kind="Service",
        metadata=k8s_client.V1ObjectMeta(
            name=f"sandbox-{sandbox_id}",
            namespace=NAMESPACE,
            labels={
                "app":        "devpilot-sandbox",
                "sandbox-id": sandbox_id,
            },
        ),
        spec=k8s_client.V1ServiceSpec(
            type="NodePort",
            selector={"sandbox-id": sandbox_id},
            ports=[
                k8s_client.V1ServicePort(
                    name="novnc",
                    port=6080,
                    target_port=6080,
                    node_port=vnc_nodeport,
                ),
                k8s_client.V1ServicePort(
                    name="bridge",
                    port=8091,
                    target_port=8091,
                    node_port=bridge_nodeport,
                ),
            ],
        ),
    )
