package collector

import "fmt"

// Bits of the firmware get_throttled value. The low bits describe the
// current state; bit n+16 is set if bit n has been set since boot.
const (
	bitUnderVoltage    = 1 << 0
	bitFrequencyCapped = 1 << 1
	bitThrottled       = 1 << 2
	bitSoftTempLimit   = 1 << 3
	occurredShift      = 16
)

// DecodeThrottled expands a get_throttled bit field.
func DecodeThrottled(v uint32) Throttling {
	raw := fmt.Sprintf("%#x", v)
	occurred := v >> occurredShift
	return Throttling{
		Supported:               true,
		Raw:                     &raw,
		UnderVoltageNow:         v&bitUnderVoltage != 0,
		FrequencyCappedNow:      v&bitFrequencyCapped != 0,
		ThrottledNow:            v&bitThrottled != 0,
		SoftTempLimitNow:        v&bitSoftTempLimit != 0,
		UnderVoltageOccurred:    occurred&bitUnderVoltage != 0,
		FrequencyCappedOccurred: occurred&bitFrequencyCapped != 0,
		ThrottledOccurred:       occurred&bitThrottled != 0,
		SoftTempLimitOccurred:   occurred&bitSoftTempLimit != 0,
	}
}
