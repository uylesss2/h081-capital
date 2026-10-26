// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity ^0.8.20;

contract StreamVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 18507475543336944384208989784753468703000929752919926323246522892316197150004;
    uint256 constant alphay  = 11767985856728659429858778422509441429862102699063823780688670845675770561771;
    uint256 constant betax1  = 15931673081882038693971546905756404466154719039779301798885281025874931067165;
    uint256 constant betax2  = 15725534130079164411862781677797251893159893603733902884277919293633396703325;
    uint256 constant betay1  = 9646905524345157781305737068632425607347662468547048319467749958188633268910;
    uint256 constant betay2  = 14840284232176824693385760320978291500613912430600322842851787869410499738512;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 11353440772115743773450147128612166615071699729507929447990552009625375750063;
    uint256 constant deltax2 = 3867446339545103066570529596328399589832315011356991283252416517862486361025;
    uint256 constant deltay1 = 11694051586727907403583371511278508647875373403745893771625510059755550307994;
    uint256 constant deltay2 = 1066858677383981708233037394408805091354176375232936428363436899558244274348;

    
    uint256 constant IC0x = 19240787438033087289579812890113245017042938479090723790757972309118582778823;
    uint256 constant IC0y = 19686995384220072101983017120649023214294251354687022339635534531462482878671;
    
    uint256 constant IC1x = 18114902412540740219822806620738190021060468037357600390199249598602472870855;
    uint256 constant IC1y = 9666334247269320792891642207809101895472605256280729628786220727027957497789;
    
    uint256 constant IC2x = 14972360186460396814241949839699043515166354549082974332319601029416815765080;
    uint256 constant IC2y = 2566644390343127902770532418186476602361304130266175746387250310754501434253;
    
    uint256 constant IC3x = 7326395774236323249918006660662037584779527985926246697956292030911527901041;
    uint256 constant IC3y = 19636351784721105458427549625204375929770141605479814853357715878864466101041;
    
    uint256 constant IC4x = 2439439797802938360788380375591247361454234208780036516593217431233898833834;
    uint256 constant IC4y = 17787396481172350478645343914627951131649115401228439748184174926879706618181;
    
    uint256 constant IC5x = 7402825314899136079018648224068341279424807489418344186304553331428402815682;
    uint256 constant IC5y = 1922919305776850111749360047527921665412145183154130423933940203930594507852;
    
    uint256 constant IC6x = 18846570101709494500966880976720775502425884790400272953794372601536349642104;
    uint256 constant IC6y = 11825791336072937000660661478472711259913227734491605965848731009449213074536;
    
    uint256 constant IC7x = 19206547366542390151168982759304619650523205658145606201529817007950931917935;
    uint256 constant IC7y = 6467871154585204919635487707007271866585052484929179254760798248655830720901;
    
    uint256 constant IC8x = 10860645189439638313653285572190137031679620708758433289796604444868894798494;
    uint256 constant IC8y = 1890828048582575364988344331162486268190534389013905817610758461151832132643;
    
    uint256 constant IC9x = 3453658118040126726915688917137978675789273955536281964743600649572545913608;
    uint256 constant IC9y = 11151118852301110421964129585281847323446285588701399337630723890922404790221;
    
    uint256 constant IC10x = 14691644221785471681948909223121372861265160544352469881009270822816528062517;
    uint256 constant IC10y = 5576746663540089170580781994059478328150412971028649204004307984127898710217;
    
    uint256 constant IC11x = 11191566172108472458451291401440022721317183432937416237754277939980412274232;
    uint256 constant IC11y = 1808438172296150381891234624775423869944501233169582583141477158018447065560;
    
    uint256 constant IC12x = 19859111473757540141670445640121122393995075199007992189765944256347280525846;
    uint256 constant IC12y = 13027997957307070139974205255086952912650149588113504316077472629213081874067;
    
    uint256 constant IC13x = 9346061654044362541965255922344010894399434433531268933923771424973765455801;
    uint256 constant IC13y = 5143487567960892056069543478741288953988400890453081597278732366168435728972;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[13] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
