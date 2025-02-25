import os
import subprocess
import random
import psutil

def get_cpu_temp():
    """Reads the CPU temperature on Raspberry Pi via vcgencmd, fallback to mock."""
    try:
        temp_output = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
        return float(temp_output.split("=")[1].split("'")[0])
    except Exception:
        return round(random.uniform(30.0, 60.0), 2)

def get_cpu_usage():
    """Returns CPU usage percentage."""
    return psutil.cpu_percent(interval=1)

def get_memory_usage():
    """Returns RAM usage percentage."""
    return psutil.virtual_memory().percent

def get_disk_usage():
    """Returns the percentage of disk usage."""
    return psutil.disk_usage('/').percent

def get_disk_space():
    """Returns total, used, and free disk space in GB."""
    disk = psutil.disk_usage('/')
    return {
        "total": round(disk.total / (1024 ** 3), 2),
        "used": round(disk.used / (1024 ** 3), 2),
        "free": round(disk.free / (1024 ** 3), 2)
    }

def get_network_stats():
    """Returns network statistics: bytes sent and received in MB."""
    net_io = psutil.net_io_counters()
    return {
        "bytes_sent": round(net_io.bytes_sent / (1024 ** 2), 2),
        "bytes_recv": round(net_io.bytes_recv / (1024 ** 2), 2)
    }

def get_mock_sensor_data():
    """Simulates a temperature sensor reading (replace with GPIO logic if needed)."""
    return round(random.uniform(20.0, 28.0), 2)

def collect_all_data():
    """Collects all system metrics and returns them as a dictionary."""
    return {
        "cpu_temp": get_cpu_temp(),
        "cpu_usage": get_cpu_usage(),
        "memory_usage": get_memory_usage(),
        "disk_usage": get_disk_usage(),
        "disk_space": get_disk_space(),
        "network": get_network_stats(),
        "sensor_temp": get_mock_sensor_data()
    }

if __name__ == "__main__":
    print(collect_all_data())
