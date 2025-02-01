# backend/app.py
import os
from flask import Flask, jsonify, request
from monitor.sensors import collect_all_data
from monitor.ai_inference import load_tflite_model, run_inference

app = Flask(__name__)

# Pre-load model if you want a single global interpreter
MODEL_PATH = os.path.join(os.path.dirname(__file__), "placeholder_model.tflite")
INTERPRETER = None

@app.before_first_request
def init_model():
    global INTERPRETER
    if os.path.exists(MODEL_PATH):
        INTERPRETER = load_tflite_model(MODEL_PATH)
    else:
        print("Warning: TFLite model not found, anomaly detection will be unavailable.")

@app.route("/")
def home():
    return jsonify({"message": "Welcome to the AI Home Server API!"})

@app.route("/metrics")
def metrics():
    data = collect_all_data()
    return jsonify(data)

@app.route("/inference", methods=["GET"])
def inference():
    # We'll assume we want to check anomaly based on sensor_temp
    # or we can accept a GET param /inference?value=XX
    value = request.args.get("value", type=float, default=None)
    if value is None:
        # get sensor data
        sensor_data = collect_all_data()
        value = sensor_data["sensor_temp"]

    if not INTERPRETER:
        return jsonify({"error": "Model not loaded"}), 500

    output = run_inference(INTERPRETER, value)
    # Suppose model output is [ [score] ] or [ [normal, anomaly] ]
    # We interpret it here as a simple anomaly score
    anomaly_score = float(output[0][0])
    # Threshold for demonstration; depends on your model
    is_anomaly = anomaly_score > 0.5

    return jsonify({
        "value_tested": value,
        "anomaly_score": anomaly_score,
        "is_anomaly": is_anomaly
    })

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
