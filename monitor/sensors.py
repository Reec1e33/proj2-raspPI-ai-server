# monitor/sensors.py
import os
import subprocess
import random

def get_cpu_temp():
    """
    Reads the CPU temperature on Raspberry Pi via vcgencmd.
    Fallback to a mock value if not on Pi or command is unavailable.
    """
    try:
        temp_output = subprocess.check_output(["vcgencmd", "measure_temp"]).decode()
        # Expected format: "temp=55.3'C\n"
        temp_str = temp_output.split("=")[1].split("'")[0]
        return float(temp_str)
    except Exception:
        # Return a mock temperature if not on a Pi or command fails
        return round(random.uniform(30.0, 60.0), 2)

def get_disk_usage():
    """
    Returns the percentage of disk usage on root partition.
    """
    stat = os.statvfs('/')
    total_blocks = stat.f_blocks
    free_blocks = stat.f_bfree
    used_blocks = total_blocks - free_blocks
    usage_percent = (used_blocks / total_blocks) * 100
    return round(usage_percent, 2)

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
    data = {
        "cpu_temp": get_cpu_temp(),
        "disk_usage": get_disk_usage(),
        "sensor_temp": get_mock_sensor_data()
    }
    return data

if __name__ == "__main__":
    print(collect_all_data())
