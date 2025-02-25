import os
import subprocess
import random
import psutil
import time

def get_cpu_temp():
    """
    Reads the CPU temperature on Raspberry Pi via vcgencmd.
    Fallback to a mock value if not on Pi or command is unavailable.
    """
    try:
        temp_output = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
        temp_str = temp_output.split("=")[1].split("'")[0]
        return float(temp_str)
    except Exception:
        return round(random.uniform(30.0, 60.0), 2)

def get_disk_usage():
    """
    Returns the percentage of disk usage on root partition.
    """
    return psutil.disk_usage('/').percent

def get_cpu_usage():
    """
    Returns the current CPU usage percentage.
    """
    return psutil.cpu_percent(interval=1)

def get_ram_usage():
    """
    Returns the current RAM usage percentage.
    """
    return psutil.virtual_memory().percent

def get_network_usage():
    """
    Returns network upload and download speed (bytes/sec) over a short interval.
    """
    net1 = psutil.net_io_counters()
    time.sleep(1)
    net2 = psutil.net_io_counters()
    upload_speed = (net2.bytes_sent - net1.bytes_sent) / 1024  # KB/s
    download_speed = (net2.bytes_recv - net1.bytes_recv) / 1024  # KB/s
    return round(upload_speed, 2), round(download_speed, 2)

def get_system_uptime():
    """
    Returns the system uptime in seconds.
    """
    return round(time.time() - psutil.boot_time(), 2)

def get_mock_sensor_data():
    """
    Simulates an external temperature sensor or other IoT sensor reading.
    Replace with actual GPIO-based code if you have a real sensor.
    """
    return round(random.uniform(20.0, 28.0), 2)

def collect_all_data():
    """
    Collect and return a dictionary of relevant metrics.
    """
    upload_speed, download_speed = get_network_usage()
    data = {
        "cpu_temp": get_cpu_temp(),
        "cpu_usage": get_cpu_usage(),
        "ram_usage": get_ram_usage(),
        "disk_usage": get_disk_usage(),
        "network_upload": upload_speed,
        "network_download": download_speed,
        "system_uptime": get_system_uptime(),
        "sensor_temp": get_mock_sensor_data()
    }
    return data

if __name__ == "__main__":
    print(collect_all_data())
